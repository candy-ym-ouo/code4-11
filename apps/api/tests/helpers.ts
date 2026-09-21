import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";
import { createSession, hashPassword } from "../src/lib/auth.js";

// 按依赖顺序清空所有业务表（identity 重置不做，UUID 主键无需复用）。
const TRUNCATE_TABLES = [
  "scan_events",
  "batch_recognitions",
  "label_events",
  "batch_labels",
  "stock_movements",
  "color_changes",
  "consumptions",
  "project_requirements",
  "projects",
  "batches",
  "materials",
  "audit_logs",
  "sessions",
  "users"
];

export async function resetDatabase(): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TRUNCATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ runDatabaseMigrations: true });
  await app.ready();
  return app;
}

export type TestContext = {
  app: FastifyInstance;
  userId: string;
  request: (method: string, url: string, options?: { body?: unknown; headers?: Record<string, string> }) => Promise<{
    status: number;
    body: any;
    headers: Record<string, string | undefined>;
  }>;
};

/** 直接在库里造操作员并生成登录会话，绕过 setup 接口的单例限制。 */
export async function createContext(app: FastifyInstance): Promise<TestContext> {
  // users 为全表单例表：测试文件串行共享同一数据库，优先复用既有操作员。
  const found = await pool.query<{ id: string; display_name: string }>("SELECT id, display_name FROM users LIMIT 1");
  const userRow = found.rows[0];
  let userId: string;
  if (userRow) {
    userId = userRow.id;
  } else {
    const inserted = await pool.query<{ id: string }>(
      "INSERT INTO users(display_name, password_hash) VALUES ($1, $2) RETURNING id",
      ["测试员", await hashPassword("test-password-123")]
    );
    userId = inserted.rows[0]!.id;
  }
  const { token } = await createSession(userId);

  const request = (method: string, url: string, options: { body?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      payload: options.body as never,
      headers: { cookie: `handcraft_session=${token}`, ...(options.headers ?? {}) }
    }).then((response) => ({
      status: response.statusCode,
      body: response.json(),
      headers: { ...response.headers } as Record<string, string | undefined>
    }));

  return { app, userId, request };
}

export async function closeApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

/** 造一枚材料，返回其 id（用克，避免单位换算干扰）。 */
export async function createMaterial(input: { name?: string; code?: string } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO materials(name, code, craft_types, stock_unit)
     VALUES ($1, $2, ARRAY['GENERAL']::craft_type[], 'g') RETURNING id`,
    [input.name ?? `材料-${randomUUID().slice(0, 8)}`, input.code ?? null]
  );
  return result.rows[0]!.id;
}

/** 造一个有库存的正式批次（绕过 API 单位换算，直接写库）。 */
export async function createBatch(input: { materialId: string; batchCode: string; quantity?: string }): Promise<string> {
  const qty = input.quantity ?? "1000";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO batches(material_id, batch_code, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit)
     VALUES ($1, $2, '2026-09-01', $3, $3, 'g', 'g') RETURNING id`,
    [input.materialId, input.batchCode, qty]
  );
  return result.rows[0]!.id;
}

export async function issueLabelApi(ctx: TestContext, batchId: string, headers?: Record<string, string>) {
  return ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {}, headers });
}

export function scanEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: randomUUID(),
    deviceId: "PDA-01",
    scannedAt: new Date().toISOString(),
    ...overrides
  };
}
