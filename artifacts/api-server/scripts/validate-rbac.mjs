// Validation step: build + start the API server on an isolated port, then run
// the RBAC/employee-flow acceptance suite against it.
// Run: node artifacts/api-server/scripts/validate-rbac.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import {
  API_DIR,
  buildApiServer,
  startApiServer,
  waitForHttp,
  track,
} from "./validation-lib.mjs";

const PORT = Number(process.env.RBAC_VALIDATION_PORT ?? 5731);

buildApiServer();
startApiServer(PORT);
await waitForHttp(`http://127.0.0.1:${PORT}/api/v1/lookup`, {
  label: "api-server",
});
// Give seeding a moment on a fresh database.
await new Promise((r) => setTimeout(r, 1000));

const test = track(
  spawn("node", [path.join(API_DIR, "scripts", "rbac-test.mjs")], {
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}/api` },
    stdio: "inherit",
    detached: true,
  }),
);

const code = await new Promise((resolve) => test.on("exit", resolve));
process.exit(code ?? 1);
