// Shared helpers for validation scripts: build & start the API server on an
// isolated port, wait for readiness, and clean up child processes.
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.resolve(API_DIR, "..", "..");

const children = [];

export function track(child) {
  children.push(child);
  return child;
}

export function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      try {
        c.kill("SIGTERM");
      } catch {}
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

export function buildApiServer() {
  console.log("[validation] building api-server...");
  execSync("node ./build.mjs", { cwd: API_DIR, stdio: "inherit" });
}

export function startApiServer(port) {
  console.log(`[validation] starting api-server on port ${port}...`);
  const child = spawn("node", ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  return track(child);
}

export async function waitForHttp(url, { timeoutMs = 60000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Any HTTP response means the server is accepting connections.
      if (res.status > 0) {
        console.log(`[validation] ${label} ready (status ${res.status})`);
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${lastErr?.message ?? "no response"}`);
}
