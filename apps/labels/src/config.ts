import { fileURLToPath } from "node:url";
import { z } from "zod";

const production = process.env.NODE_ENV === "production";
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default(production ? "0.0.0.0" : "127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3100),
  /** SQLite 数据库文件路径；:memory: 用于测试 */
  DB_PATH: z.string().min(1).default(fileURLToPath(new URL("../../../data/labels.db", import.meta.url))),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** 写锁最大等待毫秒数（better-sqlite3 busyTimeout） */
  BUSY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)
});

export const config = schema.parse(process.env);
