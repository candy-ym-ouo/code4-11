import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db.js";
import { buildTestApp, closeApp, createContext, createMaterial, resetDatabase, type TestContext } from "./helpers.js";

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

describe("batch recognition deduplication", () => {
  it("creates the batch on first recognition and never duplicates it afterwards", async () => {
    const materialId = await createMaterial({ name: "靛蓝染料", code: "DYE-INDIGO" });

    const base = {
      materialId,
      batchCode: "RC-2026-001",
      deviceId: "PDA-77",
      recognizedAt: "2026-09-20T11:00:00+08:00"
    };

    // 第一次识别：建档（PENDING）。
    const first = await ctx.request("POST", "/api/v1/recognitions", { body: { eventId: randomUUID(), ...base } });
    expect(first.status).toBe(201);
    expect(first.body.data.created).toBe(true);
    const batchId = first.body.data.batchId as string;

    // 另一台设备识别到同一（材料, 批次号）：必须复用，绝不新建。
    const otherDevice = await ctx.request("POST", "/api/v1/recognitions", {
      body: { eventId: randomUUID(), ...base, deviceId: "PDA-88", batchCode: "rc-2026-001" }
    });
    expect(otherDevice.status).toBe(200);
    expect(otherDevice.body.data.created).toBe(false);
    expect(otherDevice.body.data.batchId).toBe(batchId);

    // 新事件 ID 重放同一自然键：不新建、不标 duplicate（事件本身是新的），返回 200。
    const replayId = randomUUID();
    const replay = await ctx.request("POST", "/api/v1/recognitions", { body: { eventId: replayId, ...base } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.created).toBe(false);
    expect(replay.body.data.duplicate).toBe(false);
    // 同一事件再重放：duplicate=true。
    const replayAgain = await ctx.request("POST", "/api/v1/recognitions", { body: { eventId: replayId, ...base } });
    expect(replayAgain.status).toBe(200);
    expect(replayAgain.body.data.duplicate).toBe(true);
    expect(replayAgain.body.data.batchId).toBe(batchId);

    const count = await pool.query(
      "SELECT count(*)::int AS count FROM batches WHERE material_id = $1 AND lower(batch_code) = lower($2)",
      [materialId, "RC-2026-001"]
    );
    expect(count.rows[0]?.count).toBe(1);

    const row = await pool.query("SELECT status, remaining_quantity::text AS qty, recognized_at FROM batches WHERE id = $1", [batchId]);
    expect(row.rows[0]?.status).toBe("PENDING");
    expect(row.rows[0]?.qty).toBe("0.000000");
    expect(row.rows[0]?.recognized_at).toBeTruthy();
  });

  it("deduplicates recognitions inside the offline sync replay", async () => {
    const materialId = await createMaterial({ name: "蜂蜡", code: "WAX" });
    const eventA = randomUUID();
    const eventB = randomUUID();

    const payload = {
      deviceId: "PDA-77",
      scans: [],
      recognitions: [
        { eventId: eventA, materialId, batchCode: "OFF-1", deviceId: "PDA-77", recognizedAt: "2026-09-20T11:00:00+08:00" },
        { eventId: eventB, materialId, batchCode: "off-1", deviceId: "PDA-77", recognizedAt: "2026-09-20T11:05:00+08:00" }
      ]
    };

    const first = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(first.status).toBe(200);
    expect(first.body.data.recognitions[0].created).toBe(true);
    // 同一批内大小写不同但自然键相同：第二条必须去重。
    expect(first.body.data.recognitions[1].created).toBe(false);
    expect(first.body.data.recognitions[1].batchId).toBe(first.body.data.recognitions[0].batchId);

    // 整包重放：全部 DUPLICATE，仍只有一个批次。
    const replay = await ctx.request("POST", "/api/v1/sync", { body: payload });
    expect(replay.body.data.recognitions.map((item: { status: string }) => item.status)).toEqual(["DUPLICATE", "DUPLICATE"]);

    const count = await pool.query("SELECT count(*)::int AS count FROM batches WHERE material_id = $1", [materialId]);
    expect(count.rows[0]?.count).toBe(1);
    const recCount = await pool.query("SELECT count(*)::int AS count FROM batch_recognitions");
    expect(recCount.rows[0]?.count).toBe(2);
  });

  it("rejects recognitions for an unknown material per item without aborting the batch", async () => {
    const result = await ctx.request("POST", "/api/v1/sync", {
      body: {
        deviceId: "PDA-79",
        recognitions: [
          {
            eventId: randomUUID(),
            materialId: "00000000-0000-0000-0000-000000000099",
            batchCode: "NOPE",
            deviceId: "PDA-79",
            recognizedAt: "2026-09-20T11:00:00+08:00"
          }
        ]
      }
    });
    expect(result.status).toBe(200);
    expect(result.body.data.recognitions[0].error.code).toBe("INVALID_MATERIAL");
  });

  it("concurrent recognitions of the same natural key still create exactly one batch", async () => {
    const materialId = await createMaterial({ name: "茜草", code: "MADDER" });
    const call = () =>
      ctx.request("POST", "/api/v1/recognitions", {
        body: {
          eventId: randomUUID(),
          materialId,
          batchCode: "CONC-9",
          deviceId: "PDA-CC",
          recognizedAt: "2026-09-21T08:00:00+08:00"
        }
      });
    const responses = await Promise.all(Array.from({ length: 8 }, call));
    const batchIds = new Set(responses.map((response) => response.body.data.batchId));
    expect(batchIds.size).toBe(1);
    expect(responses.filter((response) => response.body.data.created).length).toBe(1);

    const count = await pool.query("SELECT count(*)::int AS count FROM batches WHERE material_id = $1", [materialId]);
    expect(count.rows[0]?.count).toBe(1);
  });

  it("activates the PENDING batch (no duplicate) when the official inbound arrives", async () => {
    const materialId = await createMaterial({ name: "朱砂", code: "CINNABAR" });
    // 1) 离线识别先建档。
    const recognized = await ctx.request("POST", "/api/v1/recognitions", {
      body: {
        eventId: randomUUID(),
        materialId,
        batchCode: "INB-2026",
        receivedAt: "2026-09-15",
        deviceId: "PDA-A1",
        recognizedAt: "2026-09-15T10:00:00+08:00"
      }
    });
    const pendingId = recognized.body.data.batchId;

    // 2) 正式入库同一自然键：激活同一行。
    const inbound = await ctx.request("POST", "/api/v1/batches", {
      body: {
        materialId,
        batchCode: "INB-2026",
        receivedAt: "2026-09-16",
        initialQuantity: "2.5",
        entryUnit: "kg"
      }
    });
    expect(inbound.status).toBe(201);
    expect(inbound.body.data.id).toBe(pendingId);
    expect(inbound.body.data.status).toBe("ACTIVE");
    expect(inbound.body.data.remaining_quantity).toBe("2500.000000");

    // 3) 仍然只有一个批次，且 OPENING 流水挂在它上面。
    const batches = await pool.query("SELECT count(*)::int AS count, max(status) AS status FROM batches WHERE material_id = $1", [materialId]);
    expect(batches.rows[0]?.count).toBe(1);
    expect(batches.rows[0]?.status).toBe("ACTIVE");
    const movements = await pool.query("SELECT type FROM stock_movements WHERE batch_id = $1", [pendingId]);
    expect(movements.rows.map((row) => row.type)).toEqual(["OPENING"]);

    // 4) 再以同批次号入库会得到明确冲突。
    const duplicate = await ctx.request("POST", "/api/v1/batches", {
      body: { materialId, batchCode: "INB-2026", receivedAt: "2026-09-17", initialQuantity: "1", entryUnit: "kg" }
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("BATCH_CODE_EXISTS");
  });

  it("recognizes an already online-created batch as the same row", async () => {
    const materialId = await createMaterial({ name: "苏木", code: "SAPPAN" });
    // 正式批次已存在（有库存）。
    const existing = await pool.query<{ id: string }>(
      `INSERT INTO batches(material_id, batch_code, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit)
       VALUES ($1, 'EX-1', '2026-09-01', 500, 500, 'g', 'g') RETURNING id`,
      [materialId]
    );
    const result = await ctx.request("POST", "/api/v1/recognitions", {
      body: {
        eventId: randomUUID(),
        materialId,
        batchCode: "EX-1",
        deviceId: "PDA-90",
        recognizedAt: "2026-09-21T08:00:00+08:00"
      }
    });
    expect(result.body.data.created).toBe(false);
    expect(result.body.data.batchId).toBe(existing.rows[0]!.id);
    const batches = await pool.query("SELECT count(*)::int AS count FROM batches WHERE material_id = $1", [materialId]);
    expect(batches.rows[0]?.count).toBe(1);
  });
});
