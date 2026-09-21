import Database from "better-sqlite3";
import { config } from "../config.js";

export type Db = Database.Database;

let dbInstance: Db | undefined;

export function openDatabase(path: string = config.DB_PATH): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** 进程级单例（HTTP 服务使用）；测试通过 closeDatabase 后可重新打开 */
export function getDatabase(): Db {
  if (!dbInstance) dbInstance = openDatabase();
  return dbInstance;
}

export function setDatabase(db: Db): void {
  dbInstance = db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

/**
 * 立即加写锁的事务。better-sqlite3 默认事务在首次写时才加锁，
 * 并发的重印/换签可能在同一事务内触发"一批一活动标签"唯一索引冲突，
 * 用 BEGIN IMMEDIATE 把并发写串行化，冲突表现为 BUSY 重试。
 */
export function immediateTransaction<T>(db: Db, work: () => T): T {
  type ImmediateRunner = { immediate: (...params: unknown[]) => T };
  const runner = db.transaction(work) as unknown as ImmediateRunner;
  return runner.immediate();
}
