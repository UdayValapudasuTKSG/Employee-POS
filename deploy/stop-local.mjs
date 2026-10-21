// Stop anything left listening on the local dev ports.
//
//   node deploy/stop-local.mjs        (or: pnpm run local:stop)
//
// Orphaned servers happen: a terminal window closed without Ctrl+C, a crash, or
// a parent killed in a way Windows doesn't propagate to grandchildren. The
// symptom is always `EADDRINUSE`. This clears it.
//
// Ports come from the two env files — the API's from artifacts/api-server/.env
// (LOCAL_PORT and friends applied), the front door's from
// artifacts/bhi-card-portal/.env — so they stay in sync with the launcher.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFilePath, frontendEnvFilePath, loadFrontendEnv, loadLocalEnv } from './load-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === 'win32';


const env = loadLocalEnv();
const webEnv = loadFrontendEnv();

const ports = [
  ['api', Number(env.PORT || 3101)],
  ['web', Number(process.env.WEB_PORT || webEnv.WEB_PORT || 8080)],
  ['smtp', Number(env.SMTP_PORT || 2525)],
  ['inbox (standalone)', 2526],
];

/** PIDs listening on `port`, or [] if none. */
function listenersOn(port) {
  try {
    if (isWindows) {
      // netstat is always present; -ano gives numeric addresses + owning PID.
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
        // local address is parts[1], e.g. 127.0.0.1:3101 or [::]:3101
        const match = /:(\d+)$/.exec(parts[1]);
        if (match && Number(match[1]) === port) pids.add(Number(parts[4]));
      }
      return [...pids].filter((pid) => pid > 0);
    }

    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    return out
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    // Nothing listening, or the tool returned non-zero — treat as empty.
    return [];
  }
}

function describe(pid) {
  try {
    if (isWindows) {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8' },
      ).trim();
      return out || '(unknown)';
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '(unknown)';
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours to signal
  }
}

function kill(pid) {
  try {
    if (isWindows) {
      // /T also kills the process tree, so a later pid in our list may already
      // be gone by the time we reach it.
      execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    // taskkill exits non-zero when the process no longer exists — that is a
    // success for our purposes, not a permissions problem.
    return !isAlive(pid);
  }
}

let stopped = 0;
let skipped = 0;
const seen = new Set();

for (const [label, port] of ports) {
  for (const pid of listenersOn(port)) {
    if (seen.has(pid)) continue;
    seen.add(pid);

    const command = describe(pid);
    // Only touch our own dev servers — never something unrelated that happens
    // to hold the port (VS Code owns 3001 on this machine, for instance).
    if (!/deploy[/\\](api[/\\]index|serve-local|local-delivery|start-local)/.test(command)) {
      console.log(
        `port ${port} (${label}) is held by pid ${pid}, but it is not one of ours — leaving it.\n` +
          `  ${command}`,
      );
      skipped++;
      continue;
    }

    if (kill(pid)) {
      console.log(`stopped pid ${pid}  (port ${port}, ${label})`);
      stopped++;
    } else {
      console.error(`could not stop pid ${pid} on port ${port} — try an elevated shell`);
    }
  }
}

if (stopped > 0) {
  console.log(`\n${stopped} process${stopped === 1 ? '' : 'es'} stopped.`);
}
if (skipped > 0) {
  console.log(
    `${skipped} port${skipped === 1 ? '' : 's'} still held by something else — ` +
      `stop it yourself, or change the port in ` +
      `${path.relative(path.join(here, '..'), envFilePath())} (api) or ` +
      `${path.relative(path.join(here, '..'), frontendEnvFilePath())} (web).`,
  );
} else if (stopped === 0) {
  console.log('Nothing to stop — all local dev ports are free.');
}
