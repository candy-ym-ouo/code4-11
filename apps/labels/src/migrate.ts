import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDatabase, type Db } from "./lib/db.js";

/** 执行包根目录 sql/ 下全部脚本（CREATE TABLE IF NOT EXISTS，可重复执行） */
export function runMigrations(db: Db = getDatabase()): void {
  const dir = fileURLToPath(new URL("../sql/", import.meta.url));
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf8");
    db.exec(sql);
  }
}

// 直接运行：tsx src/migrate.ts
if (process.argv[1]?.endsWith("migrate.ts")) {
  try {
    runMigrations();
    console.log("迁移完成");
  } finally {
    // getDatabase 打开的连接需要显式关闭
    process.exit(0);
  }
}
