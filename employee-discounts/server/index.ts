/**
 * Start: bring the database up to date, add the seed employees, then serve
 * the API and the web app on one port.
 */
import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./log";
import { migrate } from "./migrate";
import { seed } from "./seed";
import { seedSettings } from "./settings";
import { STORES } from "./rules";

async function main(): Promise<void> {
  await migrate();
  await seed();
  await seedSettings();
  if (config.adminEmails.size === 0) logger.warn("ADMIN_EMAILS is empty: nobody can sign in to the admin portal.");
  const missing = STORES.filter((s) => !config.posKeys[s]);
  if (missing.length) logger.warn("Stores without a POS key cannot redeem codes", { missing });
  if (config.otpDevMode) logger.warn("OTP_DEV_MODE=true: sign-in codes are shown on screen, not emailed. Local testing only.");

  const server = createApp().listen(config.port, config.host, () => {
    logger.info("Beharry Staff Discounts listening", { port: config.port, url: config.appUrl });
  });
  const stop = () => {
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  logger.error("Could not start", { err });
  process.exit(1);
});
