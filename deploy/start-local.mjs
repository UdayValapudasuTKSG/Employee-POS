// One-command local launcher for the BHI Health Card Portal.
//
//   node deploy/start-local.mjs             start and supervise everything
//   node deploy/start-local.mjs --watch     also restart a service when its file changes
//   node deploy/start-local.mjs --devcode   return OTP codes inline instead of
//                                           delivering them (needed by rbac-test.mjs)
//
// Starts both servers, keeps them running (a crashed service is restarted with
// backoff), checks the things that usually go wrong before spawning anything,
// and reformats the API's production JSON logs into readable lines.
// Ctrl+C stops both.
//
//   api   the portal API                        (deploy/api/index.mjs)
//   web   static frontend + /api proxy + the local OTP delivery sink
//         (deploy/serve-local.mjs, which embeds deploy/local-delivery.mjs)
//
// Env files:
//   artifacts/api-server/.env        the API and SMS gateway (ENV_FILE overrides)
//   artifacts/bhi-card-portal/.env   WEB_PORT, OTP_ACCEPT_ANY (WEB_ENV_FILE overrides)
// A WEB_PORT set in the shell wins over the frontend file.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyLocalOverrides,
  BACKEND_ENV_EXAMPLE,
  envFilePath,
  frontendEnvFilePath,
  loadFrontendEnv,
  parseEnvFile as parseEnv,
} from './load-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
// The backend env file is shared with the compose stack. The handful of values
// that cannot be shared — the database host, the bind address, the port, the
// SMS webhook — are carried in the same file under LOCAL_* names and applied
// below.
const envFile = envFilePath();
const webEnvFile = frontendEnvFilePath();
const webEnv = loadFrontendEnv(webEnvFile);

const WATCH = process.argv.includes('--watch');
// artifacts/api-server/scripts/rbac-test.mjs asserts on the inline `devCode`,
// which real delivery deliberately withholds. This flag flips the API back to
// dev-code mode for that run without editing the env file.
const DEVCODE = process.argv.includes('--devcode');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function die(message, hint) {
  console.error(`\n${RED}${BOLD}✗ ${message}${RESET}`);
  if (hint) console.error(`${DIM}${hint}${RESET}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Env file
// ---------------------------------------------------------------------------

function parseEnvFile(file) {
  if (!fs.existsSync(file)) {
    die(
      `Env file not found: ${file}`,
      `Copy ${BACKEND_ENV_EXAMPLE} to ${path.relative(repoRoot, file)}, then fill in the CHANGE_ME values.`,
    );
  }
  return parseEnv(file);
}

const apiEnv = parseEnvFile(envFile);

// The compose stack and this launcher disagree about four values, and neither
// setting is wrong: `db` really is the database's hostname on the compose
// network and `localhost` really is its hostname here. The alternatives live in
// the same file under a prefix compose never reads. See deploy/load-env.mjs.
applyLocalOverrides(apiEnv);

if (DEVCODE) apiEnv.OTP_DEV_MODE = 'true';
const apiPort = Number(apiEnv.PORT || 3101);
const webPort = Number(process.env.WEB_PORT || webEnv.WEB_PORT || 8080);

// Is email going to the local sink, or out through a real provider? The sink
// always runs either way — it also serves the SMS webhook and the inbox UI.
const emailIsLocal =
  apiEnv.SMTP_HOST === '127.0.0.1' || apiEnv.SMTP_HOST === 'localhost';

// Two ports, easily confused:
//   SMTP_PORT         where the API *sends*   (2525 local sink, 587 for Gmail)
//   SMTP_LISTEN_PORT  where the sink *listens* — always local, never 587
const smtpPort = Number(
  apiEnv.SMTP_LISTEN_PORT || (emailIsLocal ? apiEnv.SMTP_PORT : null) || 2525,
);

// SMS: either the local inbox webhook (path /__inbox/sms on the front door) or
// the Twilio adapter, decided purely by where SMS_WEBHOOK_URL points.
const smsUrl = apiEnv.SMS_WEBHOOK_URL || '';
const smsViaTwilio = smsUrl.includes('/sms') && !smsUrl.includes('/__inbox/');
const smsGatewayPort = Number(
  apiEnv.SMS_GATEWAY_PORT || (smsViaTwilio && smsUrl ? new URL(smsUrl).port : null) || 2527,
);

const dbUrl = apiEnv.DATABASE_URL || '';
if (!dbUrl) {
  die(`DATABASE_URL is not set in ${envFile}`);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function probeTcp(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function preflight() {
  // 1. PostgreSQL reachable?
  let dbHost = '127.0.0.1';
  let dbPort = 5432;
  try {
    const url = new URL(dbUrl);
    dbHost = url.hostname || dbHost;
    dbPort = Number(url.port || 5432);
  } catch {
    die(`DATABASE_URL in ${envFile} is not a valid URL`);
  }
  if (dbHost === 'db') {
    die(
      `DATABASE_URL in ${envFile} points at "db", the Docker service name`,
      'To run the API on this machine, add LOCAL_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/bhi_portal ' +
        'to the LOCAL_* block at the bottom of the file; Docker keeps using DATABASE_URL.',
    );
  }

  if (!(await probeTcp(dbHost, dbPort))) {
    die(
      `PostgreSQL is not accepting connections at ${dbHost}:${dbPort}`,
      'Start it with:  Start-Service postgresql-x64-15\n' +
        'Then create the database:  powershell -ExecutionPolicy Bypass -File deploy\\db\\setup-local.ps1',
    );
  }

  // 2. Ports available? This is the EADDRINUSE case, caught before we spawn.
  const wanted = [
    ['API', apiPort, `edit PORT in ${path.relative(repoRoot, envFile)}`],
    ['front door', webPort, `edit WEB_PORT in ${path.relative(repoRoot, webEnvFile)}`],
  ];
  // The sink's SMTP listener binds whether or not email is routed to it.
  wanted.push([
    'local SMTP',
    smtpPort,
    `edit SMTP_LISTEN_PORT, or stop the standalone sink`,
  ]);
  if (smsViaTwilio) {
    wanted.push([
      'SMS gateway',
      smsGatewayPort,
      `edit SMS_GATEWAY_PORT in ${path.relative(repoRoot, envFile)}`,
    ]);
  }

  for (const [label, port, fix] of wanted) {
    if (!(await portIsFree(port))) {
      die(
        `Port ${port} (${label}) is already in use`,
        `Find the owner:\n` +
          `  Get-NetTCPConnection -State Listen -LocalPort ${port} | ` +
          `Select-Object OwningProcess\n` +
          `  Get-Process -Id <pid>\n\n` +
          `Then stop it, or pick another port:\n  ${fix}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Log formatting — the prebuilt bundle always emits production JSON
// ---------------------------------------------------------------------------

const LEVELS = {
  10: ['TRACE', DIM],
  20: ['DEBUG', DIM],
  30: ['INFO ', GREEN],
  40: ['WARN ', YELLOW],
  50: ['ERROR', RED],
  60: ['FATAL', RED],
};

const NOISE = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'reqId']);

function formatApiLine(line) {
  if (!line.startsWith('{')) return line;

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return line;
  }

  const [name, colour] = LEVELS[record.level] ?? ['     ', RESET];
  const stamp = new Date(record.time ?? Date.now()).toTimeString().slice(0, 8);

  const extras = Object.entries(record)
    .filter(([key]) => !NOISE.has(key))
    .map(([key, value]) => {
      if (key === 'err' && value && typeof value === 'object') {
        return `${key}=${value.message ?? value.type ?? 'error'}`;
      }
      if (value && typeof value === 'object') {
        return `${key}=${JSON.stringify(value)}`;
      }
      return `${key}=${value}`;
    })
    .join(' ');

  return (
    `${DIM}${stamp}${RESET} ${colour}${name}${RESET} ${record.msg ?? ''}` +
    (extras ? ` ${DIM}${extras}${RESET}` : '')
  );
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const services = [];
let shuttingDown = false;

if (smsViaTwilio) {
  services.push({
    label: 'sms',
    colour: MAGENTA,
    args: ['deploy/sms-gateway.mjs'],
    env: { ...process.env, ...apiEnv, SMS_GATEWAY_PORT: String(smsGatewayPort) },
    watch: [path.join(here, 'sms-gateway.mjs')],
  });
}

services.push(
  {
    label: 'api',
    colour: CYAN,
    args: ['--enable-source-maps', 'deploy/api/index.mjs'],
    // The env file must win over anything inherited from this shell: Node
    // applies --env-file only for keys NOT already in the environment, so pass
    // the parsed values directly instead of relying on that flag.
    env: { ...process.env, ...apiEnv },
    format: formatApiLine,
    watch: [path.join(here, 'api', 'index.mjs'), envFile],
  },
  {
    label: 'web',
    colour: GREEN,
    args: ['deploy/serve-local.mjs'],
    env: {
      ...process.env,
      PORT: String(webPort),
      // Derived from the API this launcher starts, not taken from the frontend
      // file's API_PROXY_TARGET, so the two can never disagree here.
      API_TARGET: `http://127.0.0.1:${apiPort}`,
      SMTP_LISTEN_PORT: String(smtpPort),
      DELIVERY_SINK: 'on',
      ...(webEnv.OTP_ACCEPT_ANY && !process.env.OTP_ACCEPT_ANY
        ? { OTP_ACCEPT_ANY: webEnv.OTP_ACCEPT_ANY }
        : {}),
    },
    watch: [
      path.join(here, 'serve-local.mjs'),
      path.join(here, 'local-delivery.mjs'),
    ],
  },
);

function pipe(stream, service) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    if (line.trim() === '') return;
    const text = service.format ? service.format(line) : line;
    console.log(`${service.colour}[${service.label}]${RESET} ${text}`);
  });
}

function launch(service) {
  const child = spawn(process.execPath, service.args, {
    cwd: repoRoot,
    env: service.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  service.child = child;
  pipe(child.stdout, service);
  pipe(child.stderr, service);

  child.on('exit', (code, signal) => {
    if (shuttingDown || service.restarting) return;
    console.error(
      `${service.colour}[${service.label}]${RESET} ${YELLOW}exited ` +
        `(code=${code} signal=${signal})${RESET}`,
    );
    scheduleRestart(service, 'crash');
  });
}

// Keep services running, but stop flapping: more than 5 restarts inside 10s
// means the process is broken, not unlucky.
function scheduleRestart(service, cause) {
  const now = Date.now();
  service.restarts = (service.restarts ?? []).filter((t) => now - t < 10_000);
  service.restarts.push(now);

  if (service.restarts.length > 5) {
    console.error(
      `\n${RED}${BOLD}✗ ${service.label} keeps failing to start ` +
        `(5 restarts in 10s) — stopping.${RESET}\n` +
        `${DIM}Fix the error above, then run the launcher again.${RESET}\n`,
    );
    shutdown(1);
    return;
  }

  const delay = cause === 'crash' ? 700 : 150;
  service.restarting = true;
  setTimeout(() => {
    if (shuttingDown) return;
    service.restarting = false;
    console.log(
      `${service.colour}[${service.label}]${RESET} ${DIM}restarting (${cause})…${RESET}`,
    );
    launch(service);
  }, delay);
}

function restartNow(service, cause) {
  if (shuttingDown || service.restarting) return;
  service.restarting = true;
  const child = service.child;
  if (child && child.exitCode === null) {
    child.once('exit', () => {
      service.restarting = false;
      scheduleRestart(service, cause);
    });
    child.kill();
  } else {
    service.restarting = false;
    scheduleRestart(service, cause);
  }
}

function watchFiles() {
  for (const service of services) {
    for (const file of service.watch ?? []) {
      if (!fs.existsSync(file)) continue;
      let timer = null;
      fs.watch(file, () => {
        clearTimeout(timer);
        // fs.watch fires several times per save; collapse the burst.
        timer = setTimeout(() => restartNow(service, 'changed'), 300);
      });
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const service of services) {
    if (service.child && service.child.exitCode === null) service.child.kill();
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => {
  console.log(`\n${DIM}Stopping…${RESET}`);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

await preflight();

console.log(`${DIM}env files ${path.relative(repoRoot, envFile)}, ${path.relative(repoRoot, webEnvFile)}${RESET}`);
console.log(`${DIM}api       127.0.0.1:${apiPort}${RESET}`);
console.log(`${DIM}web       127.0.0.1:${webPort}${RESET}`);
console.log(
  `${DIM}email     ${
    emailIsLocal
      ? `local sink (smtp :${smtpPort}) — codes land in the inbox`
      : `${YELLOW}REAL delivery via ${apiEnv.SMTP_HOST}:${apiEnv.SMTP_PORT} as ${
          apiEnv.SMTP_USER || '(no SMTP_USER!)'
        }${RESET}${DIM} — codes are actually emailed`
  }${RESET}`,
);
console.log(
  `${DIM}sms       ${
    smsViaTwilio
      ? `${YELLOW}gateway :${smsGatewayPort} provider=${
          apiEnv.SMS_PROVIDER || 'dryrun'
        }${RESET}${DIM}${
          (apiEnv.SMS_PROVIDER || 'dryrun') === 'dryrun'
            ? ' — logs only, nothing sent'
            : ' — REAL messages are sent'
        }`
      : 'local webhook — codes land in the inbox'
  }${RESET}`,
);
console.log(
  `${DIM}otp mode  OTP_DEV_MODE=${apiEnv.OTP_DEV_MODE ?? 'unset'}${
    DEVCODE ? ' — forced by --devcode, nothing is delivered' : ''
  }${RESET}`,
);
console.log(`${DIM}watch     ${WATCH ? 'on' : 'off (pass --watch to enable)'}${RESET}\n`);

for (const service of services) launch(service);
if (WATCH) watchFiles();

// Wait for the API to answer through the proxy, then print the banner.
const deadline = Date.now() + 45_000;
let ready = false;

while (Date.now() < deadline && !shuttingDown) {
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/healthz`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (shuttingDown) {
  // nothing to announce
} else if (!ready) {
  console.error(
    `\n${YELLOW}The API did not report healthy within 45s — check the [api] logs above.${RESET}`,
  );
} else {
  const base = `http://localhost:${webPort}`;
  console.log(`
${GREEN}${BOLD}Portal is up.${RESET}

  ${BOLD}Employee card${RESET}   ${base}/
  ${BOLD}Admin portal${RESET}    ${base}/admin/login
  ${BOLD}API health${RESET}      ${base}/api/healthz
  ${BOLD}Code inbox${RESET}      ${base}/__inbox   ${DIM}← ${
    emailIsLocal ? 'email + SMS codes land here' : 'SMS codes only (email is sent for real)'
  }${RESET}

  ${DIM}Admin logins (password Demo@2026):${RESET}
    platform.admin@bhi-demo.test  super admin, all companies
    client.foods@bhi-demo.test  client admin, BF only
    hr.foods@bhi-demo.test      BF only
    hr.auto@bhi-demo.test       BA only
    support@bhi-demo.test       support
    auditor@bhi-demo.test       read-only

  ${DIM}Employee lookup: enter a member email (→ SMTP) or phone (→ SMS).${RESET}${
    !DEVCODE
      ? `
  ${YELLOW}Any 6-digit code is accepted locally${RESET}${DIM} — but only while a code
  younger than 5 minutes is in the inbox. Real emailed codes never reach the
  inbox, so email verification needs the code from your mailbox.
  Production always checks the real code; this shortcut lives only in
  deploy/serve-local.mjs, which nginx replaces. OTP_ACCEPT_ANY=false disables it.${RESET}`
      : ''
  }

${DIM}Ctrl+C stops everything. Crashed services restart automatically.${RESET}
`);
}
