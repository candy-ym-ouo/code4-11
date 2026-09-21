import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { getDatabase, type Db } from "./lib/db.js";
import { sendError } from "./lib/errors.js";
import { runMigrations } from "./migrate.js";
import { LabelService } from "./service.js";
import { labelRoutes } from "./routes/labels.js";

export interface BuildOptions {
  /** 注入数据库（测试用内存库）；缺省使用进程级单例 */
  db?: Db;
  runMigrations?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const db = options.db ?? getDatabase();
  if (options.runMigrations ?? true) runMigrations(db);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization"]
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024
  });

  app.decorate("labelService", new LabelService(db));

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (!status || status >= 500) request.log.error({ err: error }, "request failed");
    return sendError(reply, error, request.id);
  });

  app.get("/health/live", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  app.get("/health/ready", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  await app.register(labelRoutes);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    labelService: LabelService;
  }
}
