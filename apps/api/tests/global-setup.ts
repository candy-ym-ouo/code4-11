import type { GlobalSetupContext } from "vitest/node";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const here = dirname(fileURLToPath(import.meta.url));
// arm64 embedded-postgres 二进制依赖 libicuuc.so.60，库文件通过 scripts/fetch-test-libs.sh 放到 test-libs/。
process.env.LD_LIBRARY_PATH = `${resolve(here, "../test-libs")}:${process.env.LD_LIBRARY_PATH ?? ""}`;

// 测试环境没有独立 PostgreSQL：用 embedded-postgres（真实 PG18 二进制）启动临时实例。
export default async function setup(_context: GlobalSetupContext): Promise<() => Promise<void>> {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-long-enough";
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "handcraft-uploads-"));
  mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

  const databaseDir = mkdtempSync(join(tmpdir(), "handcraft-epg-"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "handcraft",
    password: "handcraft",
    port: 55433,
    persistent: false
  });
  await pg.initialise();
  await pg.start();
  process.env.DATABASE_URL = "postgresql://handcraft:handcraft@127.0.0.1:55433/postgres";

  return async () => {
    try {
      await pg.stop();
    } catch {
      // 退出时尽力清理
    }
    rmSync(databaseDir, { recursive: true, force: true });
    rmSync(process.env.UPLOAD_DIR!, { recursive: true, force: true });
  };
}
