// Local OTP delivery sink — real email + SMS verification without a paid provider.
//
// The API's *production* delivery code runs unchanged: nodemailer really opens an
// SMTP session, and the SMS webhook really receives a POST. Nothing is sent
// anywhere — captured messages are held in memory and shown in an inbox UI.
//
// Normally this runs inside deploy/serve-local.mjs (one less process to forget
// to start). It can also run standalone:
//
//   node deploy/local-delivery.mjs
//     SMTP  :2525   nodemailer target
//     HTTP  :2526   POST /sms webhook, GET / inbox
//
// Zero dependencies.

import net from 'node:net';
import http from 'node:http';

// ---------------------------------------------------------------------------
// MIME decoding — enough for the single-part text/plain mails nodemailer sends
// ---------------------------------------------------------------------------

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function decodeRfc2047(value) {
  // e.g. =?UTF-8?B?SGVsbG8=?=  or  =?UTF-8?Q?Hi=20there?=
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, encoding, payload) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return Buffer.from(payload, 'base64').toString(charset);
        }
        return decodeQuotedPrintable(payload.replace(/_/g, ' '));
      } catch {
        return payload;
      }
    },
  );
}

function parseEmail(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const headerBlock = split === -1 ? raw : raw.slice(0, split);
  let body = split === -1 ? '' : raw.slice(split + 4);

  // Unfold folded header lines, then collect them.
  const headers = {};
  for (const line of headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }

  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'quoted-printable') {
    body = decodeQuotedPrintable(body);
  } else if (encoding === 'base64') {
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }

  return {
    subject: headers['subject'] ? decodeRfc2047(headers['subject']) : null,
    to: headers['to'] ?? null,
    from: headers['from'] ?? null,
    body: body.trim(),
  };
}

function extractAddress(arg) {
  const angled = /<([^>]*)>/.exec(arg);
  if (angled) return angled[1];
  const colon = arg.indexOf(':');
  return (colon === -1 ? arg : arg.slice(colon + 1)).trim();
}

function extractCode(body) {
  const match = /\b(\d{6})\b/.exec(body ?? '');
  return match ? match[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/**
 * Starts the SMTP listener and returns the message store plus an HTTP handler
 * for the inbox UI and the SMS webhook.
 *
 * `bindHost` defaults to loopback, which is right for every process on this
 * machine. It exists because inside a container 127.0.0.1 is the container's own
 * loopback, so the API and nginx containers could not reach the sink at all —
 * the compose stack sets SINK_BIND_HOST=0.0.0.0. Do not widen the default:
 * binding all interfaces on a developer's machine would expose captured
 * verification codes to the local network.
 *
 * @param {{smtpPort?: number, bindHost?: string, maxMessages?: number, log?: (msg: string) => void}} options
 */
export function createDeliverySink({
  smtpPort = 2525,
  bindHost = process.env.SINK_BIND_HOST || '127.0.0.1',
  maxMessages = 200,
  log = console.log,
} = {}) {
  /** @type {Array<{id:number,channel:string,to:string,subject:string|null,body:string,code:string|null,receivedAt:string}>} */
  const messages = [];
  let seq = 0;

  function record(entry) {
    const message = {
      id: ++seq,
      receivedAt: new Date().toISOString(),
      code: extractCode(entry.body),
      ...entry,
    };
    messages.unshift(message);
    while (messages.length > maxMessages) messages.pop();

    log(`${message.channel} -> ${message.to}${message.code ? `  code=${message.code}` : ''}`);
    return message;
  }

  // -- SMTP -----------------------------------------------------------------

  const smtpServer = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let dataLines = [];
    let envelope = { from: null, to: [] };

    const reply = (line) => socket.write(`${line}\r\n`);

    socket.setEncoding('utf8');
    reply('220 bhi-local-dev ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(line);
      }
    });

    socket.on('error', () => {
      /* client hung up — nothing to do in a dev sink */
    });

    function handleLine(line) {
      if (inData) {
        if (line === '.') {
          inData = false;
          const parsed = parseEmail(dataLines.join('\r\n'));
          record({
            channel: 'EMAIL',
            to: envelope.to.join(', ') || parsed.to || '(unknown)',
            subject: parsed.subject,
            body: parsed.body,
            from: parsed.from ?? envelope.from,
          });
          dataLines = [];
          envelope = { from: null, to: [] };
          reply('250 2.0.0 Ok: queued as local-dev');
          return;
        }
        // Undo dot-stuffing (RFC 5321 §4.5.2).
        dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }

      const space = line.indexOf(' ');
      const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const arg = space === -1 ? '' : line.slice(space + 1);

      switch (verb) {
        case 'EHLO':
          // No STARTTLS advertised on purpose: nodemailer would try to upgrade
          // and this sink speaks plaintext only.
          socket.write(
            '250-bhi-local-dev\r\n250-SIZE 10485760\r\n250-8BITMIME\r\n250 OK\r\n',
          );
          return;
        case 'HELO':
          reply('250 bhi-local-dev');
          return;
        case 'MAIL':
          envelope.from = extractAddress(arg);
          reply('250 2.1.0 Ok');
          return;
        case 'RCPT':
          envelope.to.push(extractAddress(arg));
          reply('250 2.1.5 Ok');
          return;
        case 'DATA':
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          envelope = { from: null, to: [] };
          dataLines = [];
          inData = false;
          reply('250 2.0.0 Ok');
          return;
        case 'NOOP':
          reply('250 2.0.0 Ok');
          return;
        case 'QUIT':
          reply('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          reply('502 5.5.1 Command not implemented');
      }
    }
  });

  smtpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${smtpPort} (local SMTP) is already in use — another delivery sink is probably running.`,
      );
      process.exit(1);
    }
    throw err;
  });

  smtpServer.listen(smtpPort, bindHost, () => {
    log(`SMTP     ${bindHost}:${smtpPort}`);
  });

  // -- HTTP: inbox UI + SMS webhook ----------------------------------------

  /**
   * Handles one request for the inbox tree. `prefix` is stripped from the path,
   * so this works both standalone (prefix '') and mounted under /__inbox.
   * Returns true when the request was handled.
   */
  async function handle(req, res, prefix = '') {
    const full = (req.url ?? '/').split('?')[0];
    const route = full.slice(prefix.length) || '/';

    if (req.method === 'POST' && route === '/sms') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        json(res, 400, { ok: false, error: 'Body must be JSON' });
        return true;
      }
      if (!payload?.to || !payload?.body) {
        json(res, 400, { ok: false, error: 'Expected {"to","body"}' });
        return true;
      }
      const message = record({
        channel: 'SMS',
        to: String(payload.to),
        subject: null,
        body: String(payload.body),
      });
      // Shape mirrors a typical gateway ack so the API sees a normal 200.
      json(res, 200, { ok: true, id: `local-${message.id}`, status: 'queued' });
      return true;
    }

    if (req.method === 'GET' && route === '/messages') {
      json(res, 200, { messages });
      return true;
    }

    if (req.method === 'POST' && route === '/clear') {
      messages.length = 0;
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(inboxHtml(prefix));
      return true;
    }

    json(res, 404, { ok: false, error: `No route ${req.method} ${route}` });
    return true;
  }

  return {
    messages,
    /**
     * Newest captured verification code, or null.
     *
     * Only codes younger than `maxAgeMs` count. The default matches the API's
     * own 5-minute OTP TTL, which matters when only one channel goes through
     * this sink: with email pointed at a real provider, a stale SMS code from
     * an earlier test must not be substituted into an email verification.
     */
    latestCode({ maxAgeMs = 5 * 60_000 } = {}) {
      const cutoff = Date.now() - maxAgeMs;
      const hit = messages.find(
        (m) => m.code && new Date(m.receivedAt).getTime() >= cutoff,
      );
      return hit?.code ?? null;
    },
    clear() {
      messages.length = 0;
    },
    handle,
    close() {
      smtpServer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Inbox UI
// ---------------------------------------------------------------------------

function inboxHtml(prefix) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local delivery inbox</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f5f2; --panel: #fff; --ink: #17181b; --muted: #6b6f76;
    --line: #dcdad4; --accent: #7a5b2b; --sms: #1f6f5c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16171a; --panel:#1e2024; --ink:#eceae5; --muted:#9a9ea6;
            --line:#2e3238; --accent:#c9a35f; --sms:#4fb99b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 60px; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  .wrap { max-width: 780px; margin: 0 auto; }
  h1 { font-size:19px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin:6px 0 22px; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:18px; }
  button { font:inherit; font-size:13px; padding:6px 12px; border:1px solid var(--line);
           background:var(--panel); color:var(--ink); border-radius:7px; cursor:pointer; }
  button:hover { border-color:var(--muted); }
  .count { color:var(--muted); font-size:13px; }
  .msg { background:var(--panel); border:1px solid var(--line); border-radius:10px;
         padding:14px 16px; margin-bottom:12px; }
  .top { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:7px; }
  .tag { font-size:11px; font-weight:650; letter-spacing:.07em; padding:2px 7px;
         border-radius:5px; border:1px solid currentColor; }
  .tag.EMAIL { color:var(--accent); }
  .tag.SMS { color:var(--sms); }
  .to { font-family:ui-monospace, "Cascadia Mono", Consolas, monospace; font-size:13px; }
  .when { color:var(--muted); font-size:12px; margin-left:auto; }
  .subject { font-weight:600; font-size:14px; margin-bottom:5px; }
  .body { white-space:pre-wrap; color:var(--muted); font-size:13.5px; }
  .code { display:inline-block; margin-top:10px; font-family:ui-monospace, Consolas, monospace;
          font-size:22px; letter-spacing:.16em; font-weight:600; }
  .empty { color:var(--muted); border:1px dashed var(--line); border-radius:10px;
           padding:34px 20px; text-align:center; }
  code { font-family:ui-monospace, Consolas, monospace; font-size:12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Local delivery inbox</h1>
  <p class="sub">Verification codes captured by the local SMTP server and SMS webhook.
     Nothing leaves this machine.</p>
  <div class="bar">
    <button id="clear">Clear</button>
    <span class="count" id="count">…</span>
  </div>
  <div id="list"></div>
</div>
<script>
  const BASE = ${JSON.stringify(prefix)};
  const list = document.getElementById('list');
  const count = document.getElementById('count');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = (iso) => new Date(iso).toTimeString().slice(0, 8);

  function render(messages) {
    count.textContent = messages.length === 0
      ? 'no messages yet'
      : messages.length + (messages.length === 1 ? ' message' : ' messages');

    if (messages.length === 0) {
      list.innerHTML = '<div class="empty">Trigger a lookup at ' +
        '<code>/</code> with a member email or phone — the code lands here.</div>';
      return;
    }

    list.innerHTML = messages.map(m => \`
      <div class="msg">
        <div class="top">
          <span class="tag \${esc(m.channel)}">\${esc(m.channel)}</span>
          <span class="to">\${esc(m.to)}</span>
          <span class="when">\${when(m.receivedAt)}</span>
        </div>
        \${m.subject ? '<div class="subject">' + esc(m.subject) + '</div>' : ''}
        <div class="body">\${esc(m.body)}</div>
        \${m.code ? '<div class="code">' + esc(m.code) + '</div>' : ''}
      </div>\`).join('');
  }

  async function poll() {
    try {
      const res = await fetch(BASE + '/messages', { cache: 'no-store' });
      render((await res.json()).messages ?? []);
    } catch {
      count.textContent = 'sink unreachable';
    }
  }

  document.getElementById('clear').addEventListener('click', async () => {
    await fetch(BASE + '/clear', { method: 'POST' });
    poll();
  });

  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop(),
);

if (isMain) {
  const httpPort = Number(process.env.SINK_HTTP_PORT || 2526);
  const bindHost = process.env.SINK_BIND_HOST || '127.0.0.1';
  const sink = createDeliverySink({
    smtpPort: Number(process.env.SMTP_LISTEN_PORT || 2525),
    bindHost,
    maxMessages: Number(process.env.MAX_MESSAGES || 200),
  });

  const server = http.createServer((req, res) => {
    const full = (req.url ?? '/').split('?')[0];
    // Serve both bare paths and the /__inbox mount point.
    const prefix = full.startsWith('/__inbox') ? '/__inbox' : '';
    sink.handle(req, res, prefix);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${httpPort} (sink HTTP) is already in use.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(httpPort, bindHost, () => {
    console.log(`SMS      POST http://${bindHost}:${httpPort}/sms`);
    console.log(`Inbox    http://${bindHost}:${httpPort}/`);
  });
}
