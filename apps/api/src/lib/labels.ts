import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";
import { generateShortCode } from "./shortcode.js";

export type LabelRow = {
  id: string;
  shortCode: string;
  batchId: string;
  status: "ACTIVE" | "VOIDED" | "REPLACED";
  printSeq: number;
  predecessorId: string | null;
  successorId: string | null;
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const LABEL_COLUMNS = `
  id, short_code AS "shortCode", batch_id AS "batchId", status,
  print_seq AS "printSeq", predecessor_id AS "predecessorId",
  successor_id AS "successorId", issued_at AS "issuedAt",
  voided_at AS "voidedAt", void_reason AS "voidReason",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const MAX_SHORT_CODE_ATTEMPTS = 10;

async function insertUniqueLabel(
  client: DbClient,
  values: { batchId: string; predecessorId: string | null }
): Promise<LabelRow> {
  // 短码空间极大，冲突只在理论上发生；用 SAVEPOINT 保证冲突重试不会污染事务。
  for (let attempt = 0; attempt < MAX_SHORT_CODE_ATTEMPTS; attempt += 1) {
    const shortCode = generateShortCode();
    try {
      await client.query("SAVEPOINT label_short_code");
      const result = await client.query<LabelRow>(
        `INSERT INTO batch_labels(short_code, batch_id, predecessor_id)
         VALUES ($1::char(8), $2, $3) RETURNING ${LABEL_COLUMNS}`,
        [shortCode, values.batchId, values.predecessorId]
      );
      await client.query("RELEASE SAVEPOINT label_short_code");
      return result.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT label_short_code");
      if ((error as { code?: string }).code === "23505") continue;
      throw error;
    }
  }
  throw new AppError(503, "SHORT_CODE_EXHAUSTED", "短码生成连续冲突，请重试");
}

async function findIdempotentLabelEvent(
  client: DbClient,
  clientRequestId: string | undefined
): Promise<{ label: LabelRow; action: string } | null> {
  if (!clientRequestId) return null;
  const event = await client.query<{ label_id: string; successor_id: string | null; action: string }>(
    "SELECT label_id, successor_id, action FROM label_events WHERE client_request_id = $1",
    [clientRequestId]
  );
  if (!event.rows[0]) return null;
  const targetId = event.rows[0].successor_id ?? event.rows[0].label_id;
  const label = await client.query<LabelRow>(`SELECT ${LABEL_COLUMNS} FROM batch_labels WHERE id = $1`, [targetId]);
  return { label: label.rows[0]!, action: event.rows[0].action };
}

async function logLabelEvent(
  client: DbClient,
  input: {
    labelId: string;
    batchId: string;
    action: "ISSUE" | "REPRINT" | "VOID" | "REPLACE";
    successorId?: string | null;
    reason?: string | null;
    clientRequestId?: string | null;
    actorUserId: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO label_events(label_id, batch_id, action, successor_id, reason, client_request_id, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.labelId,
      input.batchId,
      input.action,
      input.successorId ?? null,
      input.reason ?? null,
      input.clientRequestId ?? null,
      input.actorUserId
    ]
  );
}

/** 为批次签发一枚新的 ACTIVE 短码签（每批至多一枚有效签）。 */
export async function issueLabel(
  client: DbClient,
  input: { batchId: string; actorUserId: string; clientRequestId?: string; reason?: string }
): Promise<{ label: LabelRow; idempotent: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('batch-label:' || $1, 0))", [input.batchId]);
  const replayed = await findIdempotentLabelEvent(client, input.clientRequestId);
  if (replayed) return { label: replayed.label, idempotent: true };

  const batch = await client.query<{ id: string }>("SELECT id FROM batches WHERE id = $1", [input.batchId]);
  if (!batch.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");

  const active = await client.query<{ id: string }>(
    "SELECT id FROM batch_labels WHERE batch_id = $1 AND status = 'ACTIVE' FOR SHARE",
    [input.batchId]
  );
  if (active.rows[0]) {
    throw new AppError(409, "LABEL_ALREADY_ACTIVE", "该批次已有有效标签，请改用换签或重印");
  }

  const label = await insertUniqueLabel(client, { batchId: input.batchId, predecessorId: null });
  await logLabelEvent(client, {
    labelId: label.id,
    batchId: input.batchId,
    action: "ISSUE",
    reason: input.reason,
    clientRequestId: input.clientRequestId,
    actorUserId: input.actorUserId
  });
  return { label, idempotent: false };
}

async function lockLabel(client: DbClient, shortCode: string): Promise<LabelRow> {
  const result = await client.query<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM batch_labels WHERE short_code = $1::char(8) FOR UPDATE`,
    [shortCode]
  );
  if (!result.rows[0]) throw new AppError(404, "LABEL_NOT_FOUND", "标签不存在");
  return result.rows[0];
}

/** 重印：短码不变，仅递增印次，状态必须仍为 ACTIVE。 */
export async function reprintLabel(
  client: DbClient,
  input: { shortCode: string; actorUserId: string; clientRequestId?: string; reason?: string }
): Promise<{ label: LabelRow; idempotent: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('label:' || $1, 0))", [input.shortCode]);
  const replayed = await findIdempotentLabelEvent(client, input.clientRequestId);
  if (replayed) return { label: replayed.label, idempotent: true };

  const label = await lockLabel(client, input.shortCode);
  if (label.status === "VOIDED") throw new AppError(409, "LABEL_VOIDED", "标签已作废，不能重印");
  if (label.status === "REPLACED") throw new AppError(409, "LABEL_REPLACED", "标签已换签，不能重印");

  const updated = await client.query<LabelRow>(
    "UPDATE batch_labels SET print_seq = print_seq + 1 WHERE id = $1 RETURNING " + LABEL_COLUMNS,
    [label.id]
  );
  await logLabelEvent(client, {
    labelId: label.id,
    batchId: label.batchId,
    action: "REPRINT",
    reason: input.reason,
    clientRequestId: input.clientRequestId,
    actorUserId: input.actorUserId
  });
  return { label: updated.rows[0]!, idempotent: false };
}

/** 作废：ACTIVE -> VOIDED；对已作废签重复调用按当前状态幂等返回。 */
export async function voidLabel(
  client: DbClient,
  input: { shortCode: string; reason: string; actorUserId: string; clientRequestId?: string }
): Promise<{ label: LabelRow; idempotent: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('label:' || $1, 0))", [input.shortCode]);
  const replayed = await findIdempotentLabelEvent(client, input.clientRequestId);
  if (replayed) return { label: replayed.label, idempotent: true };

  const label = await lockLabel(client, input.shortCode);
  if (label.status === "REPLACED") throw new AppError(409, "LABEL_REPLACED", "标签已换签，不能作废");
  if (label.status === "VOIDED") return { label, idempotent: true };

  const updated = await client.query<LabelRow>(
    `UPDATE batch_labels SET status = 'VOIDED', voided_at = now(), void_reason = $2
      WHERE id = $1 RETURNING ${LABEL_COLUMNS}`,
    [label.id, input.reason]
  );
  await logLabelEvent(client, {
    labelId: label.id,
    batchId: label.batchId,
    action: "VOID",
    reason: input.reason,
    clientRequestId: input.clientRequestId,
    actorUserId: input.actorUserId
  });
  return { label: updated.rows[0]!, idempotent: false };
}

/** 换签：旧签置 REPLACED 并指向新签；新签 ACTIVE，同一批次、同一事务。 */
export async function replaceLabel(
  client: DbClient,
  input: { shortCode: string; reason: string; actorUserId: string; clientRequestId?: string }
): Promise<{ label: LabelRow; oldLabel: LabelRow; idempotent: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('batch-label:' || (SELECT batch_id::text FROM batch_labels WHERE short_code = $1::char(8)), 0))", [input.shortCode]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('label:' || $1, 0))", [input.shortCode]);
  const replayed = await findIdempotentLabelEvent(client, input.clientRequestId);
  if (replayed) {
    const replayedLabel = replayed.label;
    const old = await client.query<LabelRow>(`SELECT ${LABEL_COLUMNS} FROM batch_labels WHERE short_code = $1::char(8)`, [input.shortCode]);
    return { label: replayedLabel, oldLabel: old.rows[0] ?? replayedLabel, idempotent: true };
  }

  const oldLabel = await lockLabel(client, input.shortCode);
  if (oldLabel.status === "VOIDED") throw new AppError(409, "LABEL_VOIDED", "标签已作废，不能换签");
  if (oldLabel.status === "REPLACED") {
    const successor = await client.query<LabelRow>(`SELECT ${LABEL_COLUMNS} FROM batch_labels WHERE id = $1`, [oldLabel.successorId]);
    return { label: successor.rows[0]!, oldLabel, idempotent: true };
  }

  // 先插新签（predecessor 指向仍为 ACTIVE 的旧签），再用一条 UPDATE 回填旧签 successor
  // 并置 REPLACED。两枚 ACTIVE 短暂并存，由可延迟排他约束在事务提交时收敛为一枚。
  await client.query("SET CONSTRAINTS batch_labels_one_active_excl DEFERRED");
  const newLabel = await insertUniqueLabel(client, { batchId: oldLabel.batchId, predecessorId: oldLabel.id });
  const updatedOld = await client.query<LabelRow>(
    "UPDATE batch_labels SET status = 'REPLACED', successor_id = $2 WHERE id = $1 RETURNING " + LABEL_COLUMNS,
    [oldLabel.id, newLabel.id]
  );
  await logLabelEvent(client, {
    labelId: oldLabel.id,
    batchId: oldLabel.batchId,
    action: "REPLACE",
    successorId: newLabel.id,
    reason: input.reason,
    clientRequestId: input.clientRequestId,
    actorUserId: input.actorUserId
  });
  // 新签也留下一条出生事件，标签历史从首枚签开始可串起来。
  await logLabelEvent(client, {
    labelId: newLabel.id,
    batchId: newLabel.batchId,
    action: "ISSUE",
    reason: input.reason,
    actorUserId: input.actorUserId
  });
  return { label: newLabel, oldLabel: updatedOld.rows[0]!, idempotent: false };
}

export type Resolution = {
  result: "OK" | "REPLACED" | "VOIDED" | "UNKNOWN";
  label: LabelRow | null;
  effectiveLabel: LabelRow | null;
  batch: Record<string, unknown> | null;
};

const BATCH_SUMMARY = `
  b.id, b.batch_code AS "batchCode", b.status AS "batchStatus",
  m.id AS "materialId", m.name AS "materialName",
  l.id AS "locationId", l.name AS "locationName"`;

/** 扫码解析：沿 successor 链找到当前签；结果不在此处冻结（冻结发生在写 scan_events 时）。 */
export async function resolveShortCode(client: Pick<DbClient, "query">, rawCode: string): Promise<Resolution> {
  const labelResult = await client.query<LabelRow & { depth: number }>(
    `WITH RECURSIVE chain AS (
        SELECT *, 0 AS depth FROM batch_labels WHERE short_code = $1::char(8)
        UNION ALL
        SELECT l.*, c.depth + 1 FROM batch_labels l JOIN chain c ON l.id = c.successor_id
     )
     SELECT ${LABEL_COLUMNS}, depth FROM chain ORDER BY depth DESC LIMIT 1`,
    [rawCode]
  );
  const effective = labelResult.rows[0] ?? null;

  const scanned = await client.query<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM batch_labels WHERE short_code = $1::char(8)`,
    [rawCode]
  );
  const label = scanned.rows[0] ?? null;
  if (!label || !effective) return { result: "UNKNOWN", label: null, effectiveLabel: null, batch: null };

  let result: Resolution["result"];
  if (label.status === "ACTIVE") result = "OK";
  else if (label.status === "VOIDED") result = "VOIDED";
  else result = effective.status === "ACTIVE" ? "REPLACED" : effective.status === "VOIDED" ? "VOIDED" : "REPLACED";

  const batchResult = await client.query(
    `SELECT ${BATCH_SUMMARY}
       FROM batches b JOIN materials m ON m.id = b.material_id
       LEFT JOIN storage_locations l ON l.id = b.location_id
      WHERE b.id = $1`,
    [effective.batchId]
  );
  return { result, label, effectiveLabel: effective, batch: batchResult.rows[0] ?? null };
}
