import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/lib/db.js";

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  app = await buildApp({ db, runMigrations: true });
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("HTTP 集成", () => {
  it("健康检查", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
  });

  it("登记 -> 重印 -> 旧码解析重定向 -> 扫码定位完整流程", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/v1/batches",
      payload: { bizKey: "batch-http-1", sku: "DYE-INDIGO", name: "靛蓝染液", quantity: 5, unit: "L" }
    });
    expect(reg.statusCode).toBe(201);
    const batch = reg.json();
    const oldCode: string = batch.activeLabel.shortCode;

    // 重复识别：200 + replayed，不建重复批次
    const dup = await app.inject({
      method: "POST",
      url: "/v1/batches",
      payload: { bizKey: "batch-http-1", sku: "DYE-INDIGO" }
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().replayed).toBe(true);

    // 重印（幂等键）
    const reprint = await app.inject({
      method: "POST",
      url: `/v1/labels/${oldCode}/reprint`,
      headers: { "idempotency-key": "reprint-http-1" },
      payload: { memo: "补打" }
    });
    expect(reprint.statusCode).toBe(200);
    const newCode: string = reprint.json().activeLabel.shortCode;
    expect(newCode).not.toBe(oldCode);

    // 重放同一幂等键
    const replay = await app.inject({
      method: "POST",
      url: `/v1/labels/${oldCode}/reprint`,
      headers: { "idempotency-key": "reprint-http-1" },
      payload: { memo: "补打" }
    });
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().activeLabel.shortCode).toBe(newCode);

    // 旧码解析 -> REDIRECTED
    const resolved = await app.inject({ method: "GET", url: `/v1/labels/${oldCode}/resolve` });
    expect(resolved.json()).toMatchObject({ scanResult: "REDIRECTED", requestedCode: oldCode });

    // 离线扫码补传（旧码也能定位到批次）
    const scans = await app.inject({
      method: "POST",
      url: "/v1/scans",
      payload: {
        events: [
          { eventId: "e1", deviceId: "PDA-9", rawCode: oldCode, scannedAt: "2026-09-20T08:00:00Z", station: "收货口" },
          { eventId: "e2", deviceId: "PDA-9", rawCode: newCode, scannedAt: "2026-09-20T11:00:00Z", station: "染坊", latitude: 30.1, longitude: 120.2 }
        ]
      }
    });
    expect(scans.statusCode).toBe(200);
    expect(scans.json()).toMatchObject({ accepted: 2, rejected: 0 });

    // 重放整批补传
    const scansAgain = await app.inject({
      method: "POST",
      url: "/v1/scans",
      payload: {
        events: [
          { eventId: "e1", deviceId: "PDA-9", rawCode: oldCode, scannedAt: "2026-09-20T08:00:00Z", station: "收货口" }
        ]
      }
    });
    expect(scansAgain.json().results[0]).toMatchObject({ accepted: true, replayed: true });

    // 最新定位是时间更晚的染坊
    const location = await app.inject({ method: "GET", url: `/v1/batches/${batch.batch.id}/location` });
    expect(location.json().latestLocation).toMatchObject({ station: "染坊", scanResult: "OK" });

    // 聚合视图含两张标签
    const aggregate = await app.inject({ method: "GET", url: `/v1/batches/${batch.batch.id}` });
    expect(aggregate.json().labels).toHaveLength(2);
  });

  it("作废 -> 换签不允许 -> 错误信封 409", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/v1/batches",
      payload: { bizKey: "b2", sku: "S" }
    });
    const code: string = reg.json().activeLabel.shortCode;

    const voided = await app.inject({
      method: "POST",
      url: `/v1/labels/${code}/void`,
      payload: { reason: "DAMAGED" }
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().previousLabel.status).toBe("VOID");

    const retag = await app.inject({ method: "POST", url: `/v1/labels/${code}/retag`, payload: {} });
    expect(retag.statusCode).toBe(409);
    expect(retag.json().error.code).toBe("LABEL_NOT_ACTIVE");
  });

  it("校验失败返回字段级错误", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/batches", payload: { sku: "" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.fieldErrors.bizKey).toBeDefined();
  });
});
