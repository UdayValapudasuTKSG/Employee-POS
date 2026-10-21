// Run a script with the backend env file (artifacts/api-server/.env) loaded,
// LOCAL_* applied.
//
//   node deploy/with-env.mjs deploy/api/index.mjs
//   node deploy/with-env.mjs deploy/sms-gateway.mjs
//
// Node's own --env-file would be simpler and is not enough: it cannot apply the
// LOCAL_* overrides, so the API would try to reach the database at `db`, the
// hostname that only exists on the compose network.
//
// Anything already set in the shell wins, matching --env-file's behaviour and
// keeping one-off overrides working:
//
//   $env:PORT="3999"; pnpm run local:api
//
// Zero dependencies.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFilePath, loadLocalEnv } from './load-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node deploy/with-env.mjs <script.mjs> [args...]');
  process.exit(1);
}

const file = envFilePath();
const fromFile = loadLocalEnv(file);

// The shell wins, so a deliberate one-off override is not silently ignored.
const env = { ...fromFile, ...process.env };

const child = spawn(
  process.execPath,
  ['--enable-source-maps', path.resolve(repoRoot, script), ...rest],
  { stdio: 'inherit', env, cwd: repoRoot },
);

child.on('exit', (code, signal) => {
  // Re-raise rather than translate: a script killed by a signal should look
  // killed to whatever started this, not like a clean exit.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
