import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./lib/db.js";

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ port: config.PORT }, "批次标签与扫码定位服务已启动");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "收到退出信号，正在关闭");
    await app.close();
    closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
