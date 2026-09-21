import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { batchRecognitionSchema, scanInputSchema, syncPayloadSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { normalizeShortCode } from "../lib/shortcode.js";
import { resolveShortCode } from "../lib/labels.js";
import { recordScan, recognizeBatch, type RecognitionInput, type ScanInput } from "../lib/scans.js";

type SyncItemError = { code: string; message: string };
type ItemStatus = "APPLIED" | "DUPLICATE" | "FAILED";

function summarize(items: Array<{ status: ItemStatus }>) {
  return {
    applied: items.filter((item) => item.status === "APPLIED").length,
    duplicate: items.filter((item) => item.status === "DUPLICATE").length,
    failed: items.filter((item) => item.status === "FAILED").length
  };
}

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  // 在线扫码：与离线补传共用同一套冻结/去重逻辑。
  app.post("/scans", async (request, reply) => {
    const input = parseInput(scanInputSchema, request.body);
    const code = normalizeShortCode(input.shortCode);
    if (!code) throw new AppError(422, "INVALID_SHORT_CODE", "短码格式或校验位不正确");
    const user = (request as AuthenticatedRequest).authUser;
    const outcome = await withTransaction(async (client) => {
      const scanned = await recordScan(client, { ...input, shortCode: code } as ScanInput);
      await writeAudit(client, {
        actorUserId: user.id,
        action: "SCAN",
        entityType: "SCAN_EVENT",
        entityId: undefined,
        afterData: { eventId: scanned.eventId, result: scanned.result, batchId: scanned.batchId, duplicate: scanned.duplicate },
        requestId: request.id
      });
      return scanned;
    });
    return reply.status(outcome.duplicate ? 200 : 201).send({ data: outcome });
  });

  // 仅解析短码，不落事件（给 PDA 快速查询当前定位用）。
  app.get("/resolve/:shortCode", async (request) => {
    const raw = (request.params as { shortCode: string }).shortCode;
    const code = normalizeShortCode(raw);
    if (!code) throw new AppError(422, "INVALID_SHORT_CODE", "短码格式或校验位不正确");
    const resolution = await resolveShortCode(pool, code);
    return { data: resolution };
  });

  // 离线补传：逐条 SAVEPOINT 处理，任一条失败不影响其他条目；整包可安全重放。
  app.post("/sync", async (request) => {
    const payload = parseInput(syncPayloadSchema, request.body);
    const payloadScans = payload.scans ?? [];
    const payloadRecognitions = payload.recognitions ?? [];
    const user = (request as AuthenticatedRequest).authUser;

    const scans: Array<ScanInput> = [];
    payloadScans.forEach((scan, index) => {
      const code = normalizeShortCode(scan.shortCode);
      if (!code) {
        throw new AppError(422, "INVALID_SHORT_CODE", `第 ${index + 1} 条扫码记录短码格式或校验位不正确`, {
          [`scans.${index}.shortCode`]: ["短码格式或校验位不正确"]
        });
      }
      scans.push({
        eventId: scan.eventId,
        shortCode: code,
        scannedAt: scan.scannedAt,
        deviceId: scan.deviceId ?? payload.deviceId,
        operator: scan.operator ?? null,
        locationName: scan.locationName ?? null,
        latitude: scan.latitude ?? null,
        longitude: scan.longitude ?? null,
        note: scan.note ?? null
      });
    });

    const seenEventIds = new Set<string>();
    for (const scan of payloadScans) {
      if (seenEventIds.has(scan.eventId)) {
        throw new AppError(422, "DUPLICATE_EVENT_IN_BATCH", `事件 ${scan.eventId} 在同一批补传中重复出现`);
      }
      seenEventIds.add(scan.eventId);
    }
    for (const recognition of payloadRecognitions) {
      if (seenEventIds.has(recognition.eventId)) {
        throw new AppError(422, "DUPLICATE_EVENT_IN_BATCH", `事件 ${recognition.eventId} 在同一批补传中重复出现`);
      }
      seenEventIds.add(recognition.eventId);
    }

    return withTransaction(async (client) => {
      const scanResults: Array<{ eventId: string; status: ItemStatus; result?: string; error?: SyncItemError }> = [];
      const recognitionResults: Array<{ eventId: string; status: ItemStatus; batchId?: string; created?: boolean; error?: SyncItemError }> = [];

      for (const scan of scans) {
        try {
          await client.query("SAVEPOINT sync_item");
          const outcome = await recordScan(client, scan);
          await client.query("RELEASE SAVEPOINT sync_item");
          scanResults.push({
            eventId: outcome.eventId,
            status: outcome.duplicate ? "DUPLICATE" : "APPLIED",
            result: outcome.result
          });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT sync_item");
          scanResults.push({ eventId: scan.eventId, status: "FAILED", error: toItemError(error) });
        }
      }

      for (const recognition of payloadRecognitions as RecognitionInput[]) {
        try {
          await client.query("SAVEPOINT sync_item");
          const outcome = await recognizeBatch(client, recognition, user.id);
          await client.query("RELEASE SAVEPOINT sync_item");
          recognitionResults.push({
            eventId: outcome.eventId,
            status: outcome.duplicate ? "DUPLICATE" : "APPLIED",
            batchId: outcome.batchId,
            created: outcome.created
          });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT sync_item");
          recognitionResults.push({ eventId: recognition.eventId, status: "FAILED", error: toItemError(error) });
        }
      }

      await writeAudit(client, {
        actorUserId: user.id,
        action: "SYNC_BATCH",
        entityType: "DEVICE",
        afterData: {
          deviceId: payload.deviceId,
          scans: scanResults.length,
          recognitions: recognitionResults.length,
          summary: {
            scans: summarize(scanResults),
            recognitions: summarize(recognitionResults)
          }
        },
        requestId: request.id
      });

      return {
        data: {
          deviceId: payload.deviceId,
          receivedAt: new Date().toISOString(),
          scans: scanResults,
          recognitions: recognitionResults,
          summary: {
            scans: summarize(scanResults),
            recognitions: summarize(recognitionResults)
          }
        }
      };
    });
  });

  // 补传后按事件 ID 查询入库状态（客户端确认队列用）。
  const syncStatusSchema = z.object({
    eventIds: z.array(z.string().uuid()).min(1).max(2000)
  });
  app.post("/sync/status", async (request) => {
    const { eventIds } = parseInput(syncStatusSchema, request.body);
    const scanRows = await pool.query<{ event_id: string; result: string; received_at: string }>(
      "SELECT event_id, result, received_at FROM scan_events WHERE event_id = ANY($1::uuid[])",
      [eventIds]
    );
    const recognitionRows = await pool.query<{ event_id: string; batch_id: string; received_at: string }>(
      "SELECT event_id, batch_id, received_at FROM batch_recognitions WHERE event_id = ANY($1::uuid[])",
      [eventIds]
    );
    const stored = new Map<string, { kind: "scan" | "recognition"; result?: string; batchId?: string; receivedAt: string }>();
    for (const row of scanRows.rows) {
      stored.set(row.event_id, { kind: "scan", result: row.result, receivedAt: row.received_at });
    }
    for (const row of recognitionRows.rows) {
      stored.set(row.event_id, { kind: "recognition", batchId: row.batch_id, receivedAt: row.received_at });
    }
    return {
      data: eventIds.map((eventId) => {
        const item = stored.get(eventId);
        return item
          ? { eventId, stored: true, kind: item.kind, result: item.result, batchId: item.batchId, receivedAt: item.receivedAt }
          : { eventId, stored: false };
      })
    };
  });

  // 批次扫码轨迹（定位）：按扫码设备时间排序。
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    "/batches/:id/scans",
    async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const total = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM scan_events WHERE batch_id = $1",
        [request.params.id]
      );
      const rows = await pool.query(
        `SELECT se.id, se.event_id AS "eventId", se.short_code AS "shortCode", se.result,
                se.scanned_at AS "scannedAt", se.received_at AS "receivedAt",
                se.device_id AS "deviceId", se.operator, se.location_name AS "locationName",
                se.latitude::text AS latitude, se.longitude::text AS longitude, se.note,
                l.id AS "effectiveLabelId", l.status AS "effectiveLabelStatus"
           FROM scan_events se
           LEFT JOIN batch_labels l ON l.id = se.effective_label_id
          WHERE se.batch_id = $1
          ORDER BY se.scanned_at DESC, se.received_at DESC
          LIMIT $2 OFFSET $3`,
        [request.params.id, pageSize, offset]
      );
      return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
    }
  );

  // 最近一次有效出现位置。
  app.get<{ Params: { id: string } }>("/batches/:id/last-seen", async (request) => {
    const row = await pool.query(
      `SELECT se.id, se.event_id AS "eventId", se.short_code AS "shortCode",
              se.scanned_at AS "scannedAt", se.received_at AS "receivedAt",
              se.device_id AS "deviceId", se.operator, se.location_name AS "locationName",
              se.latitude::text AS latitude, se.longitude::text AS longitude, se.note
         FROM scan_events se
        WHERE se.batch_id = $1 AND se.result = 'OK'
        ORDER BY se.scanned_at DESC, se.received_at DESC
        LIMIT 1`,
      [request.params.id]
    );
    if (!row.rows[0]) throw new AppError(404, "NO_SCAN", "该批次尚无有效扫码记录");
    return { data: row.rows[0] };
  });

  // 识别批次：自然键幂等建档（在线版，供手工录入/OCR 对接）。
  app.post("/recognitions", async (request, reply) => {
    const input = parseInput(batchRecognitionSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const outcome = await withTransaction(async (client) => recognizeBatch(client, input, user.id));
    return reply.status(outcome.duplicate ? 200 : outcome.created ? 201 : 200).send({ data: outcome });
  });
}

function toItemError(error: unknown): SyncItemError {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  const code = (error as { code?: string }).code;
  if (code === "23505") return { code: "DUPLICATE_DATA", message: "数据冲突" };
  return { code: "SYNC_ITEM_FAILED", message: "该条目处理失败" };
}
