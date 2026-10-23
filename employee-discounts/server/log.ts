/** One-line JSON logs on stdout, readable by `docker logs` and any log shipper. */
function line(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...extra };
  if (extra?.["err"] instanceof Error) entry["err"] = { message: extra["err"].message, stack: extra["err"].stack };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

export const logger = {
  info: (msg: string, extra?: Record<string, unknown>) => line("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => line("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => line("error", msg, extra),
};
