// Local development front door — the Windows/macOS stand-in for nginx.
//
// Serves the built frontend in ./web and reverse-proxies /api to the Node API
// server (deploy/api/index.mjs), so the whole portal runs on a single origin
// exactly like the nginx config in ./nginx/bhi-portal.conf does in production.
//
// It also runs the local OTP delivery sink in-process (deploy/local-delivery.mjs)
// so email and SMS verification work with nothing else to start:
//   SMTP on 127.0.0.1:2525, SMS webhook at /__inbox/sms, inbox UI at /__inbox
//
// THIS FILE NEVER RUNS IN PRODUCTION — nginx replaces it. That is why the
// demo-only OTP shortcut below is safe to live here: the API's own verification
// logic is untouched, so a real deployment always checks the real code.
//
// Zero dependencies. Run it with:
//   node deploy/serve-local.mjs
//
// Env — the process environment wins; otherwise the frontend env file
// (artifacts/bhi-card-portal/.env) supplies the value in brackets:
//   PORT             port to listen on              [WEB_PORT]         (default 8080)
//   API_TARGET       where the API server listens   [API_PROXY_TARGET] (default
//                    http://127.0.0.1:3101, matching LOCAL_PORT in the backend
//                    env — production uses 3001)
//   SMTP_LISTEN_PORT local SMTP port                (default 2525)
//   DELIVERY_SINK    "off" to not run the sink here (e.g. running it standalone)
//   OTP_ACCEPT_ANY   "false" to require the real code [OTP_ACCEPT_ANY]
//                    (default: any code accepted)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeliverySink } from './local-delivery.mjs';
import { loadFrontendEnv } from './load-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(here, 'web');
const webEnv = loadFrontendEnv();
const PORT = Number(process.env.PORT || webEnv.WEB_PORT || 8080);
const API_TARGET = new URL(
  process.env.API_TARGET || webEnv.API_PROXY_TARGET || 'http://127.0.0.1:3101',
);
const SMTP_PORT = Number(process.env.SMTP_LISTEN_PORT || 2525);
const RUN_SINK = process.env.DELIVERY_SINK !== 'off';
const ACCEPT_ANY_CODE =
  (process.env.OTP_ACCEPT_ANY ?? webEnv.OTP_ACCEPT_ANY) !== 'false';

const INBOX_PREFIX = '/__inbox';
const VERIFY_PATH = '/api/v1/otp/verify';

const sink = RUN_SINK
  ? createDeliverySink({
      smtpPort: SMTP_PORT,
      log: (msg) => console.log(`[otp] ${msg}`),
    })
  : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Proxy to the API
// ---------------------------------------------------------------------------

const API_UNAVAILABLE = {
  title: 'API unreachable',
  detail:
    `Could not reach the API server at ${API_TARGET.origin}. Is it running? ` +
    `(pnpm run local:api)`,
};

/**
 * @param {Buffer|null} body  pre-read body to send instead of streaming the request
 */
function proxyToApi(req, res, body = null) {
  const headers = { ...req.headers, host: API_TARGET.host };
  if (body) {
    headers['content-length'] = String(body.byteLength);
    delete headers['transfer-encoding'];
  }

  const upstream = http.request(
    {
      protocol: API_TARGET.protocol,
      hostname: API_TARGET.hostname,
      port: API_TARGET.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error(`[proxy] ${req.method} ${req.url} -> ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify(API_UNAVAILABLE));
  });

  if (body) {
    upstream.end(body);
  } else {
    req.pipe(upstream);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * DEMO CONVENIENCE, LOCAL ONLY: accept any 6-digit code.
 *
 * Rather than weakening the API, this swaps the code the user typed for the one
 * the sink actually captured, then forwards a normal request. The API still
 * performs its real sha256 comparison, attempt counting and lockout — it simply
 * receives the correct code. Nothing about production changes, because nginx
 * serves the frontend there and this file is never deployed.
 *
 * Skipped when: OTP_ACCEPT_ANY=false, the request carries `x-otp-strict: 1`
 * (the same opt-out the API itself honours), or no code has been captured yet
 * (which is the case in OTP_DEV_MODE, where nothing is ever delivered).
 */
async function proxyVerify(req, res) {
  const body = await readBody(req);

  if (!ACCEPT_ANY_CODE || req.headers['x-otp-strict'] === '1' || !sink) {
    proxyToApi(req, res, body);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    proxyToApi(req, res, body);
    return;
  }

  const realCode = sink.latestCode();
  if (!realCode || payload?.code === realCode) {
    proxyToApi(req, res, body);
    return;
  }

  const typed = payload?.code ?? '(none)';
  payload.code = realCode;
  console.log(`[otp] accepted any code: "${typed}" -> ${realCode}`);
  proxyToApi(req, res, Buffer.from(JSON.stringify(payload), 'utf8'));
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function sendFile(res, filePath, { immutable = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    stream.pipe(res);
  });

  stream.on('error', () => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Read error');
  });
}

function serveStatic(req, res) {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const resolved = path.join(WEB_ROOT, path.normalize(requested));

  // Never serve outside the web root.
  if (!resolved.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    sendFile(res, resolved, { immutable: requested.startsWith('/assets/') });
    return;
  }

  // Fingerprinted build assets must 404 rather than fall through to the SPA.
  if (requested.startsWith('/assets/')) {
    res.writeHead(404).end('Not found');
    return;
  }

  // SPA fallback: every app route renders index.html.
  sendFile(res, path.join(WEB_ROOT, 'index.html'));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const routePath = url.split('?')[0];

  if (routePath === VERIFY_PATH && req.method === 'POST') {
    proxyVerify(req, res).catch((err) => {
      console.error(`[otp] verify proxy failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify(API_UNAVAILABLE));
    });
    return;
  }

  if (url.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  if (routePath === INBOX_PREFIX || routePath.startsWith(`${INBOX_PREFIX}/`)) {
    if (!sink) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          title: 'Delivery sink not running here',
          detail: 'DELIVERY_SINK=off is set. Start it with: node deploy/local-delivery.mjs',
        }),
      );
      return;
    }
    sink.handle(req, res, INBOX_PREFIX).catch((err) => {
      console.error(`[otp] inbox request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end('Inbox error');
    });
    return;
  }

  serveStatic(req, res);
});

if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
  console.error(`No built frontend found at ${WEB_ROOT}/index.html`);
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use.\n` +
        `  Find the owner: Get-NetTCPConnection -State Listen -LocalPort ${PORT} | Select-Object OwningProcess\n` +
        `  Or use another:  $env:PORT="8090"; node deploy/serve-local.mjs`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Portal   http://localhost:${PORT}/`);
  console.log(`Admin    http://localhost:${PORT}/admin/login`);
  if (sink) console.log(`Inbox    http://localhost:${PORT}${INBOX_PREFIX}`);
  console.log(`API      /api/* -> ${API_TARGET.origin}`);
  if (sink && ACCEPT_ANY_CODE) {
    console.log('OTP      any 6-digit code accepted (local demo; set OTP_ACCEPT_ANY=false to enforce)');
  }
});
