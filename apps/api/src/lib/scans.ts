import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";
import { resolveShortCode, type Resolution } from "./labels.js";

export type ScanInput = {
  eventId: string;
  shortCode: string;
  scannedAt: string;
  deviceId: string;
  operator?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  note?: string | null;
};

export type ScanOutcome = {
  eventId: string;
  result: "OK" | "REPLACED" | "VOIDED" | "UNKNOWN";
  labelId: string | null;
  effectiveLabelId: string | null;
  batchId: string | null;
  shortCode: string;
  scannedAt: string;
  deviceId: string;
  duplicate: boolean;
  batch: Resolution["batch"];
};

async function readExistingScan(client: Pick<DbClient, "query">, eventId: string): Promise<ScanOutcome | null> {
  const existing = await client.query<{
    event_id: string;
    result: ScanOutcome["result"];
    label_id: string | null;
    effective_label_id: string | null;
    batch_id: string | null;
    short_code: string;
    scanned_at: string;
    device_id: string;
  }>("SELECT event_id, result, label_id, effective_label_id, batch_id, short_code, scanned_at, device_id FROM scan_events WHERE event_id = $1", [eventId]);
  const row = existing.rows[0];
  if (!row) return null;
  let batch: Resolution["batch"] = null;
  if (row.batch_id) {
    const summary = await client.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.status AS "batchStatus",
              m.id AS "materialId", m.name AS "materialName",
              l.id AS "locationId", l.name AS "locationName"
         FROM batches b JOIN materials m ON m.id = b.material_id
         LEFT JOIN storage_locations l ON l.id = b.location_id
        WHERE b.id = $1`,
      [row.batch_id]
    );
    batch = summary.rows[0] ?? null;
  }
  return {
    eventId: row.event_id,
    result: row.result,
    labelId: row.label_id,
    effectiveLabelId: row.effective_label_id,
    batchId: row.batch_id,
    shortCode: row.short_code.trim(),
    scannedAt: row.scanned_at,
    deviceId: row.device_id,
    duplicate: true,
    batch
  };
}

/**
 * 记录一次扫码（在线或离线补传单条）。
 * 必须在外层事务内调用；调用方用 SAVEPOINT 隔离多条记录，保证整批可逐条重放。
 * 解析结果在首次入库时冻结，重放返回冻结结论，不会因标签事后作废/换签而漂移。
 */
export async function recordScan(client: DbClient, input: ScanInput): Promise<ScanOutcome> {
  const replayed = await readExistingScan(client, input.eventId);
  if (replayed) return replayed;

  const resolution = await resolveShortCode(client, input.shortCode);
  const effective = resolution.effectiveLabel;
  const batchId = effective?.batchId ?? null;

  await client.query(
    `INSERT INTO scan_events(
       event_id, short_code, label_id, batch_id, result, effective_label_id,
       scanned_at, device_id, operator, location_name, latitude, longitude, note)
     VALUES ($1, $2::char(8), $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $13)`,
    [
      input.eventId,
      input.shortCode,
      resolution.label?.id ?? null,
      batchId,
      resolution.result,
      effective?.id ?? null,
      input.scannedAt,
      input.deviceId,
      input.operator ?? null,
      input.locationName ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.note ?? null
    ]
  );

  return {
    eventId: input.eventId,
    result: resolution.result,
    labelId: resolution.label?.id ?? null,
    effectiveLabelId: effective?.id ?? null,
    batchId,
    shortCode: input.shortCode,
    scannedAt: input.scannedAt,
    deviceId: input.deviceId,
    duplicate: false,
    batch: resolution.batch
  };
}

export type RecognitionInput = {
  eventId: string;
  materialId: string;
  batchCode: string;
  receivedAt?: string;
  deviceId: string;
  recognizedAt: string;
};

export type RecognitionOutcome = {
  eventId: string;
  batchId: string;
  batchCode: string;
  created: boolean;
  duplicate: boolean;
};

/**
 * 识别批次：按 (材料, 批次号) 自然键 find-or-create。
 * 重放同一事件、重复识别、多设备并发都只会返回同一批次，绝不新建第二条。
 */
export async function recognizeBatch(
  client: DbClient,
  input: RecognitionInput,
  actorUserId: string
): Promise<RecognitionOutcome> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('recognize:' || $1::text || ':' || lower($2), 0))", [
    input.materialId,
    input.batchCode
  ]);

  const seen = await client.query<{ batch_id: string; batch_code: string }>(
    "SELECT batch_id, batch_code FROM batch_recognitions WHERE event_id = $1",
    [input.eventId]
  );
  if (seen.rows[0]) {
    return { eventId: input.eventId, batchId: seen.rows[0].batch_id, batchCode: seen.rows[0].batch_code, created: false, duplicate: true };
  }

  const existing = await client.query<{ id: string; batch_code: string }>(
    "SELECT id, batch_code FROM batches WHERE material_id = $1 AND lower(batch_code) = lower($2)",
    [input.materialId, input.batchCode]
  );

  let batchId: string;
  let created: boolean;
  if (existing.rows[0]) {
    batchId = existing.rows[0].id;
    created = false;
  } else {
    const material = await client.query<{ id: string; stock_unit: string }>(
      "SELECT id, stock_unit FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE",
      [input.materialId]
    );
    if (!material.rows[0]) throw new AppError(422, "INVALID_MATERIAL", "材料不存在或已归档");
    const stockUnit = material.rows[0].stock_unit as
      | "g" | "kg" | "ml" | "l" | "mm" | "cm" | "m" | "m2" | "pcs";

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO batches(
         material_id, batch_code, received_at, initial_quantity, remaining_quantity,
         stock_unit, entry_unit, status, recognized_at, notes)
       VALUES ($1, $2, COALESCE($3::date, now()::date), 0, 0, $4::stock_unit, $4::stock_unit,
         'PENDING', $5::timestamptz, '离线识别自动建档，待正式入库补录数量')
       RETURNING id`,
      [input.materialId, input.batchCode, input.receivedAt ?? null, stockUnit, input.recognizedAt]
    );
    batchId = inserted.rows[0]!.id;
    created = true;
  }

  await client.query(
    `INSERT INTO batch_recognitions(event_id, batch_id, material_id, batch_code, device_id, recognized_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [input.eventId, batchId, input.materialId, input.batchCode, input.deviceId, input.recognizedAt]
  );

  await client.query(
    `INSERT INTO audit_logs(actor_user_id, action, entity_type, entity_id, after_data, request_id)
     VALUES ($1, $2, 'BATCH', $3, $4, NULL)`,
    [
      actorUserId,
      created ? "RECOGNIZE_CREATE" : "RECOGNIZE_DEDUP",
      batchId,
      JSON.stringify({ eventId: input.eventId, batchCode: input.batchCode, deviceId: input.deviceId, created })
    ]
  );

  return { eventId: input.eventId, batchId, batchCode: input.batchCode, created, duplicate: false };
}
