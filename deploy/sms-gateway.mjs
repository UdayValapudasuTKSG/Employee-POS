// SMS gateway adapter — the last mile between the portal and a carrier.
//
// The API posts {to, body} to SMS_WEBHOOK_URL and cares only about the HTTP
// status. This service receives that, normalises the number to E.164, hands it
// to a real SMS provider, and reports success or failure honestly so the API's
// 503 CODE_DELIVERY_UNAVAILABLE semantics keep working.
//
//   node deploy/sms-gateway.mjs
//
// Point the API at it:
//   SMS_WEBHOOK_URL=http://127.0.0.1:2527/sms
//   SMS_WEBHOOK_TOKEN=<same value as SMS_GATEWAY_TOKEN below>
//
// Configuration (env):
//   SMS_PROVIDER          twilio | vonage | dryrun          (default dryrun)
//   TWILIO_ENABLED        ON | OFF — OFF refuses every Twilio send (default ON)
//   SMS_GATEWAY_PORT      listen port                        (default 2527)
//   SMS_GATEWAY_TOKEN     require this bearer token inbound  (recommended)
//   SMS_DEFAULT_COUNTRY   digits prefixed to local numbers    (default 592, Guyana)
//   SMS_NATIONAL_LENGTH   subscriber digits for that country  (default 7 for 592)
//   SMS_GATEWAY_LOG_BODY  "true" to log message text — leaks OTP codes, dev only
//   SMS_GATEWAY_BIND_HOST listen interface                  (default 127.0.0.1)
//   SMS_ALLOWED_COUNTRY   ONLY send to this country code      (default 592, Guyana;
//                         empty string lifts the restriction)
//
//   twilio:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//            TWILIO_FROM (E.164 number) or TWILIO_MESSAGING_SERVICE_SID
//   vonage:  VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_FROM
//
// Zero dependencies.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.SMS_GATEWAY_PORT || 2527);
/**
 * Defaults to loopback, which is right for every process on this machine. It
 * exists because inside a container 127.0.0.1 is the container's own loopback,
 * so the API container could not reach the gateway at all — the compose stack
 * sets SMS_GATEWAY_BIND_HOST=0.0.0.0. Do not widen the default: binding all
 * interfaces on a developer's machine would let the local network spend the
 * Twilio balance.
 */
const BIND_HOST = process.env.SMS_GATEWAY_BIND_HOST || '127.0.0.1';
const PROVIDER = (process.env.SMS_PROVIDER || 'dryrun').toLowerCase();
/**
 * Kill switch for Twilio without touching its credentials. OFF makes every send
 * fail rather than fall back to dryrun: a dryrun "success" would tell the member
 * a code was sent when none was, and the API's CODE_DELIVERY_UNAVAILABLE path
 * exists precisely so that never happens. Anything other than OFF/false/0/no
 * leaves Twilio on, so a typo cannot silently disable production SMS.
 */
const TWILIO_ENABLED = !['off', 'false', '0', 'no'].includes(
  (process.env.TWILIO_ENABLED ?? 'ON').trim().toLowerCase(),
);
// Falls back to the API's own name for the same secret, so the gateway can read
// the backend env file (artifacts/api-server/.env) as-is and the two cannot
// drift apart.
const TOKEN = process.env.SMS_GATEWAY_TOKEN || process.env.SMS_WEBHOOK_TOKEN || '';
const DEFAULT_CC = (process.env.SMS_DEFAULT_COUNTRY || '592').replace(/\D/g, '');

/**
 * How many digits a subscriber number has behind SMS_DEFAULT_COUNTRY, used to
 * tell a bare local number from one that already carries its country code.
 *
 * Configurable rather than hardcoded so this deployment is not the only one that
 * works. It used to read `defaultCc === '592' ? 7 : null`, which silently
 * disabled local-number handling for every other country — changing
 * SMS_DEFAULT_COUNTRY alone would have looked supported and quietly done
 * nothing. KNOWN_NATIONAL_LENGTHS keeps Guyana working out of the box;
 * SMS_NATIONAL_LENGTH overrides it, and an unknown country with no override
 * falls back to passing numbers through untouched for the provider to judge.
 */
const KNOWN_NATIONAL_LENGTHS = { 592: 7 };
const NATIONAL_LENGTH = (() => {
  const configured = Number(process.env.SMS_NATIONAL_LENGTH);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return KNOWN_NATIONAL_LENGTHS[DEFAULT_CC] ?? null;
})();
const LOG_BODY = process.env.SMS_GATEWAY_LOG_BODY === 'true';

/**
 * The only country this gateway will send to. Defaults to SMS_DEFAULT_COUNTRY,
 * so a Guyana deployment is Guyana-only without being asked.
 *
 * This exists because toE164's last resort is to return `+${digits}` for a
 * number whose shape it does not recognise — deliberately, so the provider can
 * reject it with a precise error rather than have the gateway mangle it. But
 * "pass it to the provider" means a malformed number can still be billed, and
 * worse, can be a VALID number somewhere else entirely: a bare Indian mobile
 * `9121403078` became `+9121403078`, which Twilio read as an Indian landline
 * (error 21635) rather than the mobile it was meant to be. Checking the country
 * here turns that class of accident into a 400 before any money is spent.
 *
 * Set to an empty string to allow any country.
 */
const ALLOWED_CC = (process.env.SMS_ALLOWED_COUNTRY ?? DEFAULT_CC).replace(/\D/g, '');

/**
 * True when `e164` is a number this gateway is permitted to send to.
 *
 * Checks the full shape, not just the prefix: with NATIONAL_LENGTH known,
 * "+592" followed by anything is not good enough — `+5921234567890` starts with
 * the right country code and is still not a Guyana number.
 *
 * @param {string} e164
 */
export function isAllowedDestination(e164) {
  if (!ALLOWED_CC) return true;
  const prefix = `+${ALLOWED_CC}`;
  if (!e164.startsWith(prefix)) return false;
  if (NATIONAL_LENGTH === null) return true;
  const subscriber = e164.slice(prefix.length);
  return subscriber.length === NATIONAL_LENGTH && /^[0-9]+$/.test(subscriber);
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Normalise a phone number to E.164, which every provider requires.
 *
 * Guyana subscriber numbers are 7 digits behind country code 592, so a bare
 * "6454058" becomes "+5926454058" and an already-qualified "+592-645-4058"
 * survives untouched. Numbers that already carry the country code are detected
 * by length rather than a prefix test, because "592" can legitimately appear at
 * the start of a subscriber number in other countries.
 *
 * @param {string} raw
 * @param {string} defaultCc digits only, e.g. "592"
 * @param {number|null} nationalLength subscriber digits for that country
 */
export function toE164(raw, defaultCc = DEFAULT_CC, nationalLength = NATIONAL_LENGTH) {
  const trimmed = String(raw ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // Already international.
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (!defaultCc) return `+${digits}`;

  // Local subscriber number → prefix the country code.
  const localLength = nationalLength;
  if (localLength !== null && digits.length === localLength) {
    return `+${defaultCc}${digits}`;
  }

  // Country code already present but the leading + was dropped.
  if (
    digits.startsWith(defaultCc) &&
    (localLength === null || digits.length === defaultCc.length + localLength)
  ) {
    return `+${digits}`;
  }

  // Unknown shape for this country — pass it through rather than mangle it and
  // let the provider reject it with a precise error.
  return `+${digits}`;
}

/** Mask a destination for logs: +5926454058 -> +592****058 */
function maskNumber(e164) {
  if (!e164 || e164.length < 6) return '***';
  return `${e164.slice(0, 4)}****${e164.slice(-3)}`;
}

/** Redact anything that looks like a verification code. */
function redact(text) {
  return String(text ?? '').replace(/\b\d{4,8}\b/g, '******');
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`SMS_PROVIDER=${PROVIDER} needs: ${missing.join(', ')}`);
  }
}

/**
 * Twilio. Success is HTTP 201; the error body carries `message` and `code`.
 * `TWILIO_API_BASE` exists so the tests can point at a mock.
 */
async function sendViaTwilio({ to, body }) {
  if (!TWILIO_ENABLED) {
    throw new Error('Twilio is switched off (TWILIO_ENABLED=OFF) — nothing was sent');
  }
  requireEnv('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const base = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

  const form = new URLSearchParams({ To: to, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  } else {
    requireEnv('TWILIO_FROM');
    form.set('From', process.env.TWILIO_FROM);
  }

  const auth = Buffer.from(
    `${sid}:${process.env.TWILIO_AUTH_TOKEN}`,
    'utf8',
  ).toString('base64');

  const res = await fetch(`${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Twilio ${res.status}: ${payload?.message ?? 'unknown error'}` +
        (payload?.code ? ` (code ${payload.code})` : ''),
    );
  }
  return { id: payload?.sid ?? null, status: payload?.status ?? 'queued' };
}

/**
 * Vonage. Note it answers HTTP 200 even for rejected messages — the real
 * outcome is messages[0].status, where "0" means accepted. Treating 200 as
 * success here would silently swallow every failure.
 */
async function sendViaVonage({ to, body }) {
  requireEnv('VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_FROM');
  const base = process.env.VONAGE_API_BASE || 'https://rest.nexmo.com';

  const res = await fetch(`${base}/sms/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.VONAGE_API_KEY,
      api_secret: process.env.VONAGE_API_SECRET,
      to: to.replace(/^\+/, ''), // Vonage wants digits only
      from: process.env.VONAGE_FROM,
      text: body,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await res.json().catch(() => null);
  const first = payload?.messages?.[0];
  if (!res.ok || !first) {
    throw new Error(`Vonage ${res.status}: unexpected response`);
  }
  if (first.status !== '0') {
    throw new Error(
      `Vonage rejected the message: status ${first.status}` +
        (first['error-text'] ? ` — ${first['error-text']}` : ''),
    );
  }
  return { id: first['message-id'] ?? null, status: 'accepted' };
}

/** No provider — log and report success. Verifies wiring without spending. */
async function sendViaDryRun({ to }) {
  return { id: null, status: 'dryrun', note: `would send to ${to}` };
}

const PROVIDERS = {
  twilio: sendViaTwilio,
  vonage: sendViaVonage,
  dryrun: sendViaDryRun,
};

export async function sendSms({ to, body }) {
  const send = PROVIDERS[PROVIDER];
  if (!send) {
    throw new Error(
      `Unknown SMS_PROVIDER "${PROVIDER}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return send({ to, body });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // A verification SMS is a couple of hundred bytes; anything larger is
      // not ours.
      if (size > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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

function tokenMatches(header) {
  if (!TOKEN) return true; // no token configured — accept (loopback only)
  const provided = /^Bearer\s+(.*)$/i.exec(header ?? '')?.[1] ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHandler() {
  return async function handle(req, res) {
    const route = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && route === '/healthz') {
      json(res, 200, {
        status: 'ok',
        provider: PROVIDER,
        ...(PROVIDER === 'twilio' && { twilioEnabled: TWILIO_ENABLED }),
      });
      return;
    }

    if (req.method !== 'POST' || route !== '/sms') {
      json(res, 404, { ok: false, error: `No route ${req.method} ${route}` });
      return;
    }

    if (!tokenMatches(req.headers.authorization)) {
      console.warn('[sms] rejected a request with a bad or missing token');
      json(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, error: 'Body must be JSON' });
      return;
    }

    if (!payload?.to || !payload?.body) {
      json(res, 400, { ok: false, error: 'Expected {"to","body"}' });
      return;
    }

    const to = toE164(payload.to);
    if (!to) {
      json(res, 400, { ok: false, error: `Unusable destination: ${payload.to}` });
      return;
    }

    // Refused here rather than at the provider: a wrong-country number is
    // either a data-entry mistake or a number that belongs to somebody else,
    // and both are worth stopping before they cost money.
    if (!isAllowedDestination(to)) {
      console.warn(
        `[sms] REFUSED ${maskNumber(to)} — not a +${ALLOWED_CC} number`,
      );
      json(res, 400, {
        ok: false,
        error:
          `Refusing to send to ${to}: this gateway only delivers to ` +
          `+${ALLOWED_CC} numbers. Store the number in full international ` +
          `form (+${ALLOWED_CC}...) or set SMS_ALLOWED_COUNTRY.`,
      });
      return;
    }

    try {
      const result = await sendSms({ to, body: String(payload.body) });
      console.log(
        `[sms] sent to ${maskNumber(to)} via ${PROVIDER} ` +
          `(${result.status}${result.id ? ` id=${result.id}` : ''})` +
          (LOG_BODY ? ` :: ${payload.body}` : ''),
      );
      json(res, 200, { ok: true, to, provider: PROVIDER, ...result });
    } catch (err) {
      // Non-2xx here makes the API expire the verification session and tell the
      // member codes cannot be delivered — which is the truth.
      console.error(
        `[sms] FAILED to ${maskNumber(to)} via ${PROVIDER}: ${err.message}` +
          (LOG_BODY ? '' : ` (body redacted: ${redact(payload.body)})`),
      );
      json(res, 502, { ok: false, error: err.message, provider: PROVIDER });
    }
  };
}

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  if (PROVIDER === 'dryrun') {
    console.warn(
      '[sms] SMS_PROVIDER=dryrun — messages are logged, NOT sent. ' +
        'Set SMS_PROVIDER=twilio or vonage with credentials to send for real.',
    );
  }
  if (PROVIDER === 'twilio' && !TWILIO_ENABLED) {
    console.warn(
      '[sms] TWILIO_ENABLED=OFF — every SMS is REFUSED and members are told the ' +
        'code cannot be delivered. Set TWILIO_ENABLED=ON to send for real.',
    );
  }
  if (!TOKEN) {
    console.warn(
      '[sms] SMS_GATEWAY_TOKEN is not set — any local process can send messages ' +
        'at your expense. Set it here and as SMS_WEBHOOK_TOKEN in the API env.',
    );
  }

  const server = http.createServer(createHandler());
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[sms] gateway listening on http://${BIND_HOST}:${PORT}/sms`);
    console.log(`[sms] provider=${PROVIDER}  default country=+${DEFAULT_CC}`);
    console.log(
      ALLOWED_CC
        ? `[sms] restricted to +${ALLOWED_CC} numbers only`
        : '[sms] SMS_ALLOWED_COUNTRY is empty — ANY country may be messaged',
    );
  });
}
