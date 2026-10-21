import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { corsOptions } from "./lib/cors";
import { logger } from "./lib/logger";
import { resolveRequestId } from "./lib/requestId";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler";

const app: Express = express();

/**
 * Whose `X-Forwarded-For` to believe.
 *
 * Express trusts nobody by default, so behind nginx `req.ip` is the proxy's own
 * 127.0.0.1 — and `req.ip` is what every audit row records as the actor's
 * source address. An audit trail that says every action came from localhost
 * cannot answer the one question it exists to answer.
 *
 * Trusting the header unconditionally is the worse failure: while the API is
 * reachable directly, as it is in development, any caller could name their own
 * address and write a false source IP into the trail. So this is configuration,
 * and the default stays "trust nobody".
 *
 * Set TRUST_PROXY to the number of proxies between the client and this server —
 * `1` for the standard single-nginx deployment, which trusts only the last hop.
 * Any value express accepts also works ("loopback", a subnet).
 */
const trustProxy = process.env["TRUST_PROXY"]?.trim();
if (trustProxy) {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

app.use(
  pinoHttp({
    logger,
    // Reuse nginx's $request_id when it forwarded one, so one reference finds
    // both the nginx access line and everything this API logged for the same
    // request. See lib/requestId.ts.
    genReqId: (req, res) => {
      const id = resolveRequestId(req.headers["x-request-id"]);
      // Echoed back so the id is visible in a browser's network tab and in
      // curl -i, without having to trigger an error to see it.
      res.setHeader("X-Request-Id", id);
      return id;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Allowlist, not `*` — see lib/cors.ts. Mounted before the body parsers so a
// refused preflight is answered without buffering anything.
app.use(cors(corsOptions()));

/**
 * Body parsing, with two routes allowed a larger limit.
 *
 * Everything else keeps the 100 kB default deliberately: body parsing happens
 * before any route runs, and therefore before authentication, so a global
 * multi-megabyte limit would let an unauthenticated caller make the server
 * buffer that much per request.
 *
 * The two exceptions genuinely need it:
 *   - an RFM carries its supporting document inline as base64, so a 5 MB file
 *     arrives as ~6.8 MB of JSON;
 *   - a bulk import sends the parsed workbook as JSON, and a real carrier file
 *     is far bigger than 100 kB. 567 rows across the Members and Dependants
 *     sheets is already ~110 kB, which the default silently rejected with a
 *     413 before any of the import code ran.
 *
 * A single dispatching middleware rather than stacked parsers: mounting a
 * second express.json() only happens to work because body-parser skips an
 * already-consumed request, which is version-dependent behaviour. This parses
 * exactly once and says so.
 */
const jsonDefault = express.json();
const jsonLarge = express.json({ limit: "12mb" });
const LARGE_BODY_PATHS = new Set([
  "/api/v1/card/change-requests",
  "/api/v1/admin/import",
]);

app.use((req, res, next) =>
  req.method === "POST" && LARGE_BODY_PATHS.has(req.path)
    ? jsonLarge(req, res, next)
    : jsonDefault(req, res, next),
);
app.use(express.urlencoded({ extended: true }));

/**
 * Turn body-parser's failures into the API's error envelope.
 *
 * Without this a request over the limit produces body-parser's own HTML-ish
 * error with no `error.message`, which the frontend can only report as
 * "Unable to process the data" — true but useless.
 */
app.use(
  (
    err: Error & { type?: string; status?: number; statusCode?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!err || res.headersSent) return next(err);
    const status = err.status ?? err.statusCode;

    if (err.type === "entity.too.large" || status === 413) {
      res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message:
            "That file is too large to send in one request. Split it into smaller files and import them one at a time.",
        },
      });
      return;
    }
    if (err.type === "entity.parse.failed" || (status === 400 && "body" in err)) {
      res.status(400).json({
        error: { code: "INVALID_JSON", message: "The request body could not be read." },
      });
      return;
    }
    next(err);
  },
);

app.use("/api", router);

/**
 * Both scoped to /api, and both after the router.
 *
 * Scoped rather than global because nginx is what serves the frontend: only
 * /api/ is proxied here, so anything else arriving is a direct call in
 * development, and answering it with an API-shaped JSON 404 would be a lie about
 * what this server is for.
 *
 * Order matters and is fixed: express tries these in registration order, so the
 * 404 has to come after every real route, and the error handler — identified by
 * its four parameters — has to be last of all, or errors from the middleware
 * above it have nowhere to go and fall back to express's blank 500.
 */
app.use("/api", notFoundHandler);
app.use(errorHandler);

export default app;
