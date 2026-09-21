import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db.js";
import { buildTestApp, closeApp, createBatch, createContext, createMaterial, resetDatabase, type TestContext } from "./helpers.js";

let ctx: TestContext;

async function setupBatchWithLabel(batchCode: string) {
  const materialId = await createMaterial();
  const batchId = await createBatch({ materialId, batchCode });
  const issued = await ctx.request("POST", `/api/v1/batches/${batchId}/labels`, { body: {} });
  return { materialId, batchId, code: issued.body.data.shortCode as string };
}

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

describe("online scans", () => {
  it("records an OK scan with a position and exposes the batch trail", async () => {
    const { batchId, code } = await setupBatchWithLabel("S-001");
    const eventId = randomUUID();
    const scanned = await ctx.request("POST", "/api/v1/scans", {
      body: {
        eventId,
        shortCode: code,
        scannedAt: "2026-09-21T09:00:00+08:00",
        deviceId: "PDA-01",
        operator: "张三",
        locationName: "染坊 A 区",
        latitude: 31.2304,
        longitude: 121.4737
      }
    });
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.result).toBe("OK");
    expect(scanned.body.data.batchId).toBe(batchId);

    const trail = await ctx.request("GET", `/api/v1/batches/${batchId}/scans`);
    expect(trail.body.data).toHaveLength(1);
    expect(trail.body.data[0].locationName).toBe("染坊 A 区");
    expect(trail.body.data[0].latitude).toBe("31.230400");

    const lastSeen = await ctx.request("GET", `/api/v1/batches/${batchId}/last-seen`);
    expect(lastSeen.body.data.deviceId).toBe("PDA-01");
  });

  it("never inserts a second scan row for the same event id", async () => {
    const { code } = await setupBatchWithLabel("S-002");
    const eventId = randomUUID();
    const body = {
      eventId,
      shortCode: code,
      scannedAt: "2026-09-21T10:00:00+08:00",
      deviceId: "PDA-01"
    };
    const first = await ctx.request("POST", "/api/v1/scans", { body });
    const second = await ctx.request("POST", "/api/v1/scans", { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);

    const count = await pool.query("SELECT count(*)::int AS count FROM scan_events WHERE event_id = $1", [eventId]);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("records UNKNOWN scans without creating anything and rejects malformed codes", async () => {
    const scanned = await ctx.request("POST", "/api/v1/scans", {
      body: { eventId: randomUUID(), shortCode: "XZ79XZ7G", scannedAt: new Date().toISOString(), deviceId: "PDA-09" }
    });
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.result).toBe("UNKNOWN");
    expect(scanned.body.data.batchId).toBeNull();

    const bad = await ctx.request("POST", "/api/v1/scans", {
      body: { eventId: randomUUID(), shortCode: "ABC", scannedAt: new Date().toISOString(), deviceId: "PDA-09" }
    });
    expect(bad.status).toBe(422);
  });
});

describe("offline sync replay", () => {
  it("applies a mixed backfill batch and replays it as a whole without duplicates", async () => {
    const { batchId, code } = await setupBatchWithLabel("S-100");
    const replaced = await ctx.request("POST", `/api/v1/labels/${code}/replace`, { body: { reason: "换签" } });
    const newCode = replaced.body.data.successor.shortCode as string;

    const payload = {
      deviceId: "PDA-42",
      scans: [
        { eventId: randomUUID(), shortCode: code, scannedAt: "2026-09-20T08:00:00+08:00", locationName: "旧签扫描点" },
        { eventId: randomUUID(), shortCode: newCode, scannedAt: "2026-09-20T09:30:00+08:00", locationName: "新签扫描点" }
      ],
      recognitions: []
    };

    const first = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(first.status).toBe(200);
    expect(first.body.data.scans.map((item: { status: string }) => item.status)).toEqual(["APPLIED", "APPLIED"]);
    expect(first.body.data.scans[0].result).toBe("REPLACED");
    expect(first.body.data.scans[1].result).toBe("OK");

    // 整包重放：全部 DUPLICATE，行数不变。
    const replay = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(replay.body.data.scans.every((item: { status: string }) => item.status === "DUPLICATE")).toBe(true);

    const rowCount = await pool.query("SELECT count(*)::int AS count FROM scan_events WHERE device_id = 'PDA-42'");
    expect(rowCount.rows[0]?.count).toBe(2);

    // 即使后来新签作废，重放旧事件仍返回首次冻结的 REPLACED 结论。
    await ctx.request("POST", `/api/v1/labels/${newCode}/void`, { body: { reason: "作废" } });
    const replayAfterVoid = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(replayAfterVoid.body.data.scans[0].result).toBe("REPLACED");
    expect(replayAfterVoid.body.data.scans[1].result).toBe("OK");

    // 轨迹仍能定位到批次（旧签 REPLACED 扫描也挂在批次上）。
    const trail = await ctx.request("GET", `/api/v1/batches/${batchId}/scans`);
    expect(trail.body.data).toHaveLength(2);
  });

  it("keeps applying good items when one item is invalid", async () => {
    const { code } = await setupBatchWithLabel("S-101");
    const goodId = randomUUID();
    const payload = {
      deviceId: "PDA-43",
      scans: [
        { eventId: goodId, shortCode: code, scannedAt: "2026-09-20T08:00:00+08:00" }
      ],
      recognitions: [
        { eventId: randomUUID(), materialId: "00000000-0000-0000-0000-000000000099", batchCode: "GHOST-1", deviceId: "PDA-43", recognizedAt: "2026-09-20T08:05:00+08:00" }
      ]
    };
    const result = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(result.status).toBe(200);
    expect(result.body.data.scans[0].status).toBe("APPLIED");
    expect(result.body.data.recognitions[0].error.code).toBe("INVALID_MATERIAL");
  });

  it("answers the sync status probe", async () => {
    const { code } = await setupBatchWithLabel("S-102");
    const eventId = randomUUID();
    const unknownId = randomUUID();
    await ctx.request("POST", "/api/v1/sync", {
      body: { deviceId: "PDA-44", scans: [{ eventId, shortCode: code, scannedAt: "2026-09-20T08:00:00+08:00" }] }
    });
    const status = await ctx.request("POST", "/api/v1/sync/status", { body: { eventIds: [eventId, unknownId] } });
    const byId = Object.fromEntries(status.body.data.map((item: { eventId: string }) => [item.eventId, item]));
    expect(byId[eventId].stored).toBe(true);
    expect(byId[eventId].kind).toBe("scan");
    expect(byId[unknownId].stored).toBe(false);
  });

  it("rejects repeated event ids within one batch", async () => {
    const { code } = await setupBatchWithLabel("S-103");
    const eventId = randomUUID();
    const result = await ctx.request("POST", "/api/v1/sync", {
      body: {
        deviceId: "PDA-45",
        scans: [
          { eventId, shortCode: code, scannedAt: "2026-09-20T08:00:00+08:00" },
          { eventId, shortCode: code, scannedAt: "2026-09-20T08:01:00+08:00" }
        ]
      }
    });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("DUPLICATE_EVENT_IN_BATCH");
  });
});
