import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db.js";
import { buildTestApp, closeApp, createBatch, createContext, createMaterial, resetDatabase, type TestContext } from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  const app = await buildTestApp();
  ctx = await createContext(app);
});

afterAll(async () => {
  await closeApp(ctx.app);
});

beforeEach(async () => {
  await resetDatabase();
  ctx = await createContext(ctx.app);
});

describe("batch label lifecycle", () => {
  it("issues one active label per batch and rejects a second issue", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-001" });

    const first = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe("ACTIVE");
    expect(first.body.data.printSeq).toBe(1);
    expect(first.body.data.shortCode).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{8}$/);

    const second = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("LABEL_ALREADY_ACTIVE");

    const dbCount = await pool.query("SELECT count(*)::int AS count FROM batch_labels WHERE batch_id = $1", [batchId]);
    expect(dbCount.rows[0]?.count).toBe(1);
  });

  it("reprints the same short code with an incremented print sequence", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-002" });
    const issued = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const code = issued.body.data.shortCode;

    const reprint = await ctx.request("POST", `/api/v1/labels/${code}/reprint`, { body: { reason: "标签磨损" } });
    expect(reprint.status).toBe(201);
    expect(reprint.body.data.shortCode).toBe(code);
    expect(reprint.body.data.printSeq).toBe(2);
    expect(reprint.body.data.status).toBe("ACTIVE");

    const again = await ctx.request("POST", `/api/v1/labels/${code}/reprint`, { body: { reason: "再次重印" } });
    expect(again.body.data.printSeq).toBe(3);

    const events = await pool.query("SELECT action FROM label_events WHERE label_id = $1 ORDER BY created_at", [issued.body.data.id]);
    expect(events.rows.map((row) => row.action)).toEqual(["ISSUE", "REPRINT", "REPRINT"]);
  });

  it("makes reprint idempotent with the same Idempotency-Key", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-002K" });
    const issued = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const code = issued.body.data.shortCode;
    const headers = { "Idempotency-Key": "reprint-7788" };

    const first = await ctx.request("POST", `/api/v1/labels/${code}/reprint`, { body: {}, headers });
    expect(first.status).toBe(201);
    expect(first.body.data.printSeq).toBe(2);

    const retry = await ctx.request("POST", `/api/v1/labels/${code}/reprint`, { body: {}, headers });
    expect(retry.status).toBe(200);
    expect(retry.body.data.printSeq).toBe(2);

    const count = await pool.query("SELECT count(*)::int AS count FROM label_events WHERE client_request_id = $1", ["reprint-7788"]);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("voids a label and rejects further reprints", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-003" });
    const issued = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const code = issued.body.data.shortCode;

    const voided = await ctx.request("POST", `/api/v1/labels/${code}/void`, { body: { reason: "实物遗失" } });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe("VOIDED");
    expect(voided.body.data.voidedAt).toBeTruthy();

    // 重复作废是幂等的。
    const voidAgain = await ctx.request("POST", `/api/v1/labels/${code}/void`, { body: { reason: "实物遗失" } });
    expect(voidAgain.status).toBe(200);
    expect(voidAgain.body.data.status).toBe("VOIDED");

    const reprint = await ctx.request("POST", `/api/v1/labels/${code}/reprint`, { body: {} });
    expect(reprint.status).toBe(409);
    expect(reprint.body.error.code).toBe("LABEL_VOIDED");

    // 作废后可以为批次签发新签。
    const reissue = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    expect(reissue.status).toBe(201);
    expect(reissue.body.data.status).toBe("ACTIVE");
    expect(reissue.body.data.shortCode).not.toBe(code);
  });

  it("replaces a label: old scans resolve through the chain to the new code", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-004" });
    const issued = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const oldCode = issued.body.data.shortCode as string;

    const replaced = await ctx.request("POST", `/api/v1/labels/${oldCode}/replace`, { body: { reason: "污损换签" } });
    expect(replaced.status).toBe(201);
    const newCode = replaced.body.data.successor.shortCode as string;
    expect(newCode).not.toBe(oldCode);
    expect(replaced.body.data.old.status).toBe("REPLACED");
    expect(replaced.body.data.successor.status).toBe("ACTIVE");

    // 每批仍然只有一枚 ACTIVE。
    const activeCount = await pool.query(
      "SELECT count(*)::int AS count FROM batch_labels WHERE batch_id = $1 AND status = 'ACTIVE'",
      [batchId]
    );
    expect(activeCount.rows[0]?.count).toBe(1);

    // 扫旧码得到 REPLACED 且指向新签与同批次。
    const oldResolve = await ctx.request("GET", `/api/v1/resolve/${oldCode}`);
    expect(oldResolve.status).toBe(200);
    expect(oldResolve.body.data.result).toBe("REPLACED");
    expect(oldResolve.body.data.effectiveLabel.shortCode).toBe(newCode);
    expect(oldResolve.body.data.batch.id).toBe(batchId);

    // 扫新码是 OK。
    const newResolve = await ctx.request("GET", `/api/v1/resolve/${newCode}`);
    expect(newResolve.body.data.result).toBe("OK");
    expect(newResolve.body.data.batch.id).toBe(batchId);

    // 旧签不能再次重印/换签（已终结），重放换签请求幂等返回同一新签。
    const reprintOld = await ctx.request("POST", `/api/v1/labels/${oldCode}/reprint`, { body: {} });
    expect(reprintOld.status).toBe(409);
    const replaceAgain = await ctx.request("POST", `/api/v1/labels/${oldCode}/replace`, { body: { reason: "污损换签" } });
    expect(replaceAgain.status).toBe(200);
    expect(replaceAgain.body.data.successor.shortCode).toBe(newCode);
  });

  it("chains two replacements and always resolves to the latest code", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-005" });
    const first = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const code1 = first.body.data.shortCode as string;

    const r1 = await ctx.request("POST", `/api/v1/labels/${code1}/replace`, { body: { reason: "换签" } });
    const code2 = r1.body.data.successor.shortCode as string;
    const r2 = await ctx.request("POST", `/api/v1/labels/${code2}/replace`, { body: { reason: "再次换签" } });
    const code3 = r2.body.data.successor.shortCode as string;

    const resolve1 = await ctx.request("GET", `/api/v1/resolve/${code1}`);
    expect(resolve1.body.data.result).toBe("REPLACED");
    expect(resolve1.body.data.effectiveLabel.shortCode).toBe(code3);
    const resolve2 = await ctx.request("GET", `/api/v1/resolve/${code2}`);
    expect(resolve2.body.data.effectiveLabel.shortCode).toBe(code3);
  });

  it("voided successor makes the old code report VOIDED", async () => {
    const materialId = await createMaterial();
    const batchId = await createBatch({ materialId, batchCode: "B-006" });
    const first = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
    const code1 = first.body.data.shortCode as string;
    const replaced = await ctx.request("POST", `/api/v1/labels/${code1}/replace`, { body: { reason: "换签" } });
    const code2 = replaced.body.data.successor.shortCode as string;
    await ctx.request("POST", `/api/v1/labels/${code2}/void`, { body: { reason: "批次报废" } });

    const resolveOld = await ctx.request("GET", `/api/v1/resolve/${code1}`);
    expect(resolveOld.body.data.result).toBe("VOIDED");
    expect(resolveOld.body.data.batch.id).toBe(batchId);
  });

  it("returns 404 and 422 for unknown and malformed codes", async () => {
    const badCheck = await ctx.request("GET", "/api/v1/resolve/ZZZZ0000");
    expect(badCheck.status).toBe(422); // 校验位不正确
    const goodShape = "00000000"; // 校验位合法（全 0），库里不存在
    const notFound = await ctx.request("GET", `/api/v1/resolve/${goodShape}`);
    expect(notFound.status).toBe(200);
    expect(notFound.body.data.result).toBe("UNKNOWN");
  });
});
