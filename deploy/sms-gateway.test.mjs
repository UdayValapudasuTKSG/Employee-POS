// Tests for the SMS gateway adapter. No credentials and no network: a local
// mock stands in for the carrier and records exactly what it was sent.
//
//   node --test deploy/sms-gateway.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayPath = path.join(here, 'sms-gateway.mjs');

// --- helpers ---------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** A stand-in carrier that records requests and replies how the test wants. */
function mockCarrier(handler) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      raw,
    });
    handler(req, res, raw);
  });
  return { server, received };
}

// Each gateway gets its own port. A counter beats randomness here: the tests
// stay reproducible and cannot collide with each other.
let nextPort = 24101;

/** Boot the gateway as a child process with the given env; resolve its port. */
async function startGateway(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, ...env, SMS_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  // Poll until it answers, rather than sleeping a fixed amount. Give up early
  // if the child died, so a startup crash fails loudly instead of timing out.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `gateway exited with code ${exited} before becoming ready:\n${logs.join('')}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return { child, port, logs, stop: () => child.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`gateway never became ready on ${port}:\n${logs.join('')}`);
}

function postSms(port, payload, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

// --- E.164 normalisation ---------------------------------------------------

test('toE164 handles the Guyana formats that appear in member data', async () => {
  const { toE164 } = await import('./sms-gateway.mjs');

  // Seeded data format, and the same number typed loosely.
  assert.equal(toE164('+592-645-4058', '592'), '+5926454058');
  assert.equal(toE164('+592 645 4058', '592'), '+5926454058');
  assert.equal(toE164('5926454058', '592'), '+5926454058');

  // Bare 7-digit Guyana subscriber number gains the country code.
  assert.equal(toE164('6454058', '592'), '+5926454058');

  // Already international, other country — left alone.
  assert.equal(toE164('+14155550123', '592'), '+14155550123');

  // Unusable input.
  assert.equal(toE164('', '592'), null);
  assert.equal(toE164('not a number', '592'), null);
});

// --- country restriction ----------------------------------------------------

test('only the configured country is accepted, checked on shape not prefix', async () => {
  const { isAllowedDestination } = await import('./sms-gateway.mjs');

  // Guyana, the default.
  assert.equal(isAllowedDestination('+5926454058'), true);

  // The regression this exists for: a bare Indian mobile that toE164 cannot
  // recognise becomes "+9121403078", which Twilio reads as an Indian LANDLINE
  // and rejects with 21635. Refused here instead, before it costs anything.
  assert.equal(isAllowedDestination('+9121403078'), false);
  assert.equal(isAllowedDestination('+919121403078'), false);
  assert.equal(isAllowedDestination('+14155550123'), false);

  // Right country code, wrong length — a prefix test alone would pass these.
  assert.equal(isAllowedDestination('+5921234567890'), false);
  assert.equal(isAllowedDestination('+59264540'), false);
});

test('a wrong-country number is refused without ever reaching the provider', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM_should_not_happen', status: 'queued' }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
    SMS_DEFAULT_COUNTRY: '592',
  });

  try {
    const res = await postSms(gw.port, { to: '9121403078', body: 'code 123456' });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /only delivers to \+592/);

    // The point of the test: no spend, no send.
    assert.equal(mock.received.length, 0);
  } finally {
    await gw.stop();
    await close(mock.server);
  }
});

test('SMS_ALLOWED_COUNTRY can be emptied to lift the restriction', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM_intl', status: 'queued' }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
    SMS_DEFAULT_COUNTRY: '592',
    SMS_ALLOWED_COUNTRY: '',
  });

  try {
    const res = await postSms(gw.port, { to: '+14155550123', body: 'code 123456' });
    assert.equal(res.status, 200);
    assert.equal(mock.received.length, 1);
  } finally {
    await gw.stop();
    await close(mock.server);
  }
});

// --- Twilio ----------------------------------------------------------------

test('sends through Twilio with the right auth, form fields and E.164 number', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM123', status: 'queued' }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
    SMS_DEFAULT_COUNTRY: '592',
  });

  try {
    const res = await postSms(gw.port, {
      to: '+592-645-4058',
      body: 'Your NALICO verification code is 123456. It expires in 10 minutes.',
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.to, '+5926454058');
    assert.equal(payload.id, 'SM123');

    assert.equal(mock.received.length, 1);
    const call = mock.received[0];
    assert.equal(call.url, '/2010-04-01/Accounts/AC_test_sid/Messages.json');
    assert.equal(
      call.headers.authorization,
      `Basic ${Buffer.from('AC_test_sid:tok_secret').toString('base64')}`,
    );
    assert.match(call.headers['content-type'], /application\/x-www-form-urlencoded/);

    const form = new URLSearchParams(call.raw);
    assert.equal(form.get('To'), '+5926454058'); // normalised, not the raw dashes
    assert.equal(form.get('From'), '+15005550006');
    assert.match(form.get('Body'), /verification code is 123456/);
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

test('a Twilio rejection becomes a non-2xx so the API reports delivery failure', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: "The 'To' number is not a valid phone number", code: 21211 }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
  });

  try {
    const res = await postSms(gw.port, { to: '+5920000000', body: 'code 123456' });
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /21211/);
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

test('TWILIO_ENABLED=OFF refuses the send and never reaches Twilio', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM_should_not_happen', status: 'queued' }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ENABLED: 'OFF',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
  });

  try {
    const health = await (await fetch(`http://127.0.0.1:${gw.port}/healthz`)).json();
    assert.equal(health.twilioEnabled, false);

    // Non-2xx, not a fake success: the API must tell the member no code went out.
    const res = await postSms(gw.port, { to: '+5926454058', body: 'code 123456' });
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /TWILIO_ENABLED=OFF/);
    assert.equal(mock.received.length, 0);
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

test('MessagingServiceSid is used instead of From when set', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM999', status: 'accepted' }));
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: 'tok_secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MG_abc',
    TWILIO_API_BASE: `http://127.0.0.1:${carrierPort}`,
  });

  try {
    const res = await postSms(gw.port, { to: '6454058', body: 'code 123456' });
    assert.equal(res.status, 200);
    const form = new URLSearchParams(mock.received[0].raw);
    assert.equal(form.get('MessagingServiceSid'), 'MG_abc');
    assert.equal(form.get('From'), null);
    assert.equal(form.get('To'), '+5926454058'); // 7-digit local number qualified
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

// --- Vonage ----------------------------------------------------------------

test('Vonage failure hidden behind HTTP 200 is still reported as a failure', async () => {
  // Vonage answers 200 with a non-zero status for rejected messages. Trusting
  // the HTTP code would swallow every failure.
  const mock = mockCarrier((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        'message-count': '1',
        messages: [{ status: '4', 'error-text': 'Bad Credentials' }],
      }),
    );
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'vonage',
    VONAGE_API_KEY: 'key',
    VONAGE_API_SECRET: 'secret',
    VONAGE_FROM: 'NALICO',
    VONAGE_API_BASE: `http://127.0.0.1:${carrierPort}`,
  });

  try {
    const res = await postSms(gw.port, { to: '+5926454058', body: 'code 123456' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Bad Credentials/);
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

test('Vonage success is accepted and the number is sent without a plus', async () => {
  const mock = mockCarrier((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ messages: [{ status: '0', 'message-id': 'VG-1' }] }),
    );
  });
  const carrierPort = await listen(mock.server);

  const gw = await startGateway({
    SMS_PROVIDER: 'vonage',
    VONAGE_API_KEY: 'key',
    VONAGE_API_SECRET: 'secret',
    VONAGE_FROM: 'NALICO',
    VONAGE_API_BASE: `http://127.0.0.1:${carrierPort}`,
  });

  try {
    const res = await postSms(gw.port, { to: '+592-645-4058', body: 'code 123456' });
    assert.equal(res.status, 200);
    const sent = JSON.parse(mock.received[0].raw);
    assert.equal(sent.to, '5926454058');
    assert.equal(sent.from, 'NALICO');
  } finally {
    gw.stop();
    await close(mock.server);
  }
});

// --- inbound auth and validation ------------------------------------------

test('the bearer token is enforced when configured', async () => {
  const gw = await startGateway({
    SMS_PROVIDER: 'dryrun',
    SMS_GATEWAY_TOKEN: 'shared-secret',
  });

  try {
    assert.equal((await postSms(gw.port, { to: '6454058', body: 'x 123456' })).status, 401);

    assert.equal(
      (
        await postSms(
          gw.port,
          { to: '6454058', body: 'x 123456' },
          { authorization: 'Bearer wrong' },
        )
      ).status,
      401,
    );

    assert.equal(
      (
        await postSms(
          gw.port,
          { to: '6454058', body: 'x 123456' },
          { authorization: 'Bearer shared-secret' },
        )
      ).status,
      200,
    );
  } finally {
    gw.stop();
  }
});

test('malformed payloads are rejected without reaching a provider', async () => {
  const gw = await startGateway({ SMS_PROVIDER: 'dryrun' });

  try {
    const noBody = await postSms(gw.port, { to: '6454058' });
    assert.equal(noBody.status, 400);

    const noTo = await postSms(gw.port, { body: 'code 123456' });
    assert.equal(noTo.status, 400);

    const junkTo = await postSms(gw.port, { to: 'abc', body: 'code 123456' });
    assert.equal(junkTo.status, 400);

    const notJson = await fetch(`http://127.0.0.1:${gw.port}/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(notJson.status, 400);
  } finally {
    gw.stop();
  }
});

test('OTP codes are kept out of the logs unless explicitly enabled', async () => {
  const gw = await startGateway({ SMS_PROVIDER: 'dryrun' });
  try {
    await postSms(gw.port, {
      to: '+5926454058',
      body: 'Your NALICO verification code is 987654.',
    });
    await new Promise((r) => setTimeout(r, 300));
    const output = gw.logs.join('');
    assert.ok(!output.includes('987654'), 'the code must not appear in logs');
    assert.ok(!output.includes('+5926454058'), 'the full number must be masked');
    assert.match(output, /\+592\*\*\*\*058/);
  } finally {
    gw.stop();
  }
});
