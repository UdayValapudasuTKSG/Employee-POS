import fs from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { fail } from "./auth";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./log";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { employeeRouter } from "./routes/employee";
import { posRouter } from "./routes/pos";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());

  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "up" });
    } catch {
      res.status(503).json({ status: "degraded", database: "down" });
    }
  });
  app.use(authRouter);
  app.use(employeeRouter);
  app.use(posRouter);
  app.use(adminRouter);
  app.use("/api", (req, res) => fail(res, 404, "NOT_FOUND", `No API route matches ${req.method} ${req.path}.`));

  // The web app: built files, and index.html for every client-side route.
  const web = [path.resolve(process.cwd(), "web/dist")].find((d) => fs.existsSync(path.join(d, "index.html")));
  if (web) {
    app.use(express.static(web, { index: false, maxAge: "1h", setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(web, "index.html"));
    });
  } else {
    logger.warn("web/dist not found: serving the API only (run `npm run build:web`, or use `npm run dev:web`)");
  }

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return fail(res, 400, "INVALID_JSON", "The request body could not be read.");
    if (err.type === "entity.too.large") return fail(res, 413, "PAYLOAD_TOO_LARGE", "The request is too large.");
    logger.error("Unhandled error", { err });
    fail(res, 500, "INTERNAL_ERROR", "Something went wrong on our side. Try again shortly.");
  });
  return app;
}
