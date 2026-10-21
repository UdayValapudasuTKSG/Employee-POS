// Reads the repository's two env files.
//
//   artifacts/api-server/.env        backend  — database, secrets, delivery
//   artifacts/bhi-card-portal/.env   frontend — base URL, ports, proxy
//
// No key lives in both. The backend file is shared by the compose stack and by
// the non-Docker launcher. Four of its values cannot be shared — the database
// host, the bind address, the API port and the SMS webhook are genuinely
// different when the API runs in a container and when it runs on your machine —
// so the file carries the host alternatives under LOCAL_* names and this
// applies them. The compose stack never reads a LOCAL_ prefix.
//
// Zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

export const BACKEND_ENV_EXAMPLE = 'artifacts/api-server/.env.example';
export const FRONTEND_ENV_EXAMPLE = 'artifacts/bhi-card-portal/.env.example';

/** The backend env file, unless ENV_FILE names another. */
export function envFilePath() {
  return process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.join(repoRoot, 'artifacts', 'api-server', '.env');
}

/** The frontend env file, unless WEB_ENV_FILE names another. */
export function frontendEnvFilePath() {
  return process.env.WEB_ENV_FILE
    ? path.resolve(process.env.WEB_ENV_FILE)
    : path.join(repoRoot, 'artifacts', 'bhi-card-portal', '.env');
}

/**
 * Parse KEY=value lines. Comments, blanks and malformed lines are skipped, and
 * a value wrapped in matching quotes is unwrapped.
 */
export function parseEnvFile(file) {
  const vars = {};
  if (!fs.existsSync(file)) return vars;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

/**
 * Apply the LOCAL_* overrides in place: LOCAL_FOO replaces FOO and is then
 * removed, so nothing downstream ever sees the prefix.
 *
 * An empty LOCAL_FOO is ignored rather than treated as "set FOO to nothing" —
 * blanking a value is what deleting the line means, and a stray `LOCAL_PORT=`
 * should not silently unset the port.
 */
export function applyLocalOverrides(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith('LOCAL_')) continue;
    delete vars[key];
    if (value !== '') vars[key.slice('LOCAL_'.length)] = value;
  }
  return vars;
}

/** The env for a process running on this machine rather than in a container. */
export function loadLocalEnv(file = envFilePath()) {
  return applyLocalOverrides(parseEnvFile(file));
}

/** The frontend's env. Empty when the file does not exist — every key has a default. */
export function loadFrontendEnv(file = frontendEnvFilePath()) {
  return parseEnvFile(file);
}
