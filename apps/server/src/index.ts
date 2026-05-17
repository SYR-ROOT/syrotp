import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/index.js";
import { closeRedis } from "./lib/redis.js";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(
      { env: config.NODE_ENV, port: config.PORT },
      `SYROTP server listening on ${config.HOST}:${config.PORT}`,
    );
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await closeRedis();
      await closeDb();
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Don't crash on unhandled rejections in production — log and continue.
  process.on("unhandledRejection", (reason) => {
    app.log.error({ reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaught exception — exiting");
    void shutdown("uncaughtException");
  });
}

void main();
