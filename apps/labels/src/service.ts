import { createHash, randomUUID } from "node:crypto";
import { immediateTransaction, type Db } from "./lib/db.js";
import { generateShortCode, normalizeCode } from "./lib/code.js";
import { AppError, isUniqueError } from "./lib/errors.js";
import { nowIso, parseClientIso } from "./lib/time.js";

/* ---------------- 类型与行模型 ---------------- */

export type LabelStatus = "ACTIVE" | "SUPERSEDED" | "VOID";

export interface LabelInput {
  memo?: string;
}

export interface RegisterInput extends LabelInput {
  /** 上游/识别侧稳定业务键：同一物理批次重复识别必须给出同一 bizKey */
  bizKey: string;
  sku: string;
  name?: string;
  quantity?: number;
  unit?: string;
  attributes?: Record<string, unknown>;
}

export interface ScanInput {
  /** 设备端事件 UUID；离线补传必须稳定，用于重放去重。缺省由字段指纹派生 */
  eventId?: string;
  deviceId: string;
  rawCode: string;
  scannedAt: string;
  station?: string;
  latitude?: number;
  longitude?: number;
}

export type ScanResult = "OK" | "REDIRECTED" | "VOIDED" | "NOT_FOUND" | "BAD_CODE";

interface BatchRow {
  id: string;
  biz_key: string;
  sku: string;
  name: string | null;
  quantity: number | null;
  unit: string | null;
  attributes_json: string;
  created_at: string;
  updated_at: string;
}

interface LabelRow {
  id: number;
  batch_id: string;
  seq: number;
  short_code: string;
  status: LabelStatus;
  replace_reason: string | null;
  replaced_by_id: number | null;
  memo: string | null;
  created_at: string;
  replaced_at: string | null;
}

interface LedgerRow {
  op_id: string;
  op_type: string;
  request_json: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  response_json: string | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ScanRow {
  event_id: string;
  device_id: string;
  short_code: string;
  scanned_at: string;
  received_at: string;
  station: string | null;
  latitude: number | null;
  longitude: number | null;
  resolved_label_id: number | null;
  resolved_batch_id: string | null;
  scan_result: ScanResult;
  detail_json: string;
}

/* ---------------- JSON 序列化 ---------------- */

export function batchJson(row: BatchRow) {
  return {
    id: row.id,
    bizKey: row.biz_key,
    sku: row.sku,
    name: row.name ?? undefined,
    quantity: row.quantity ?? undefined,
    unit: row.unit ?? undefined,
    attributes: JSON.parse(row.attributes_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function labelJson(row: LabelRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    shortCode: row.short_code,
    status: row.status,
    replaceReason: row.replace_reason ?? undefined,
    replacedById: row.replaced_by_id ?? undefined,
    memo: row.memo ?? undefined,
    createdAt: row.created_at,
    replacedAt: row.replaced_at ?? undefined
  };
}

export function scanJson(row: ScanRow) {
  return {
    eventId: row.event_id,
    deviceId: row.device_id,
    shortCode: row.short_code,
    scannedAt: row.scanned_at,
    receivedAt: row.received_at,
    station: row.station ?? undefined,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    resolvedLabelId: row.resolved_label_id ?? undefined,
    resolvedBatchId: row.resolved_batch_id ?? undefined,
    scanResult: row.scan_result,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>
  };
}

/* ---------------- 服务 ---------------- */

export interface TransitionResult {
  batch: ReturnType<typeof batchJson>;
  activeLabel?: ReturnType<typeof labelJson>;
  previousLabel?: ReturnType<typeof labelJson>;
  /** true 表示本次为幂等重放或重复识别，未产生新副作用 */
  replayed?: boolean;
}

export class LabelService {
  constructor(private readonly db: Db) {}

  /* ===== 工具 ===== */

  private getBatchRow(batchId: string): BatchRow {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!row) throw new AppError(404, "BATCH_NOT_FOUND", "批次不存在");
    return row;
  }

  private getLabelByCode(code: string): LabelRow {
    const row = this.db.prepare("SELECT * FROM labels WHERE short_code = ?").get(code) as LabelRow | undefined;
    if (!row) throw new AppError(404, "LABEL_NOT_FOUND", `未找到短码 ${code} 对应的标签`);
    return row;
  }

  /** 为批次签发下一张标签；短码冲突由 UNIQUE 索引兜底并重试 */
  private issueLabel(batchId: string, memo: string | undefined, timestamp: string): LabelRow {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM labels WHERE batch_id = ?")
      .get(batchId) as { next_seq: number };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateShortCode();
      try {
        const result = this.db.prepare(`
          INSERT INTO labels (batch_id, seq, short_code, status, memo, created_at)
          VALUES (?, ?, ?, 'ACTIVE', ?, ?)
        `).run(batchId, seqRow.next_seq, code, memo ?? null, timestamp);
        return this.db.prepare("SELECT * FROM labels WHERE id = ?").get(result.lastInsertRowid) as LabelRow;
      } catch (error) {
        if (isUniqueError(error)) continue; // short_code 极小概率撞码，换一个
        throw error;
      }
    }
    throw new AppError(503, "CODE_ALLOCATION_BUSY", "短码连续冲突，请重试");
  }

  /**
   * 用一张新 ACTIVE 标签替换当前 ACTIVE 标签（重印/换签共用）。
   * 顺序必须是"旧标签先让位 -> 插入新标签 -> 回填 replaced_by"，
   * 否则新旧两张 ACTIVE 同时存在会违反部分唯一索引 ux_labels_one_active。
   */
  private replaceActive(previous: LabelRow, reason: string, memo: string | undefined, timestamp: string) {
    this.db.prepare(`
      UPDATE labels
         SET status = 'SUPERSEDED', replace_reason = ?, replaced_by_id = NULL, replaced_at = ?
       WHERE id = ?
    `).run(reason, timestamp, previous.id);
    const active = this.issueLabel(previous.batch_id, memo, timestamp);
    this.db.prepare("UPDATE labels SET replaced_by_id = ? WHERE id = ?").run(active.id, previous.id);
    this.db.prepare("UPDATE batches SET updated_at = ? WHERE id = ?").run(timestamp, previous.batch_id);
    const replaced = this.db.prepare("SELECT * FROM labels WHERE id = ?").get(previous.id) as LabelRow;
    return { active, replaced };
  }

  /**
   * 写操作幂等包装。同一 opId 的重放直接返回首次响应，不重复执行副作用；
   * 未提供 opId 时直接执行（调用方需保证业务键去重，如批次 bizKey）。
   */
  private withOp<T extends object>(
    opId: string | undefined,
    opType: string,
    request: Record<string, unknown>,
    work: () => T
  ): T & { replayed?: boolean } {
    if (!opId) return work();

    return immediateTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM operation_ledger WHERE op_id = ?").get(opId) as LedgerRow | undefined;
      if (existing) {
        if (existing.status !== "COMPLETED" || !existing.response_json) {
          // 前次请求在执行中途崩溃（极罕见）。请客户端用同一 opId 重试。
          throw new AppError(409, "OPERATION_INTERRUPTED", "操作状态不确定，请用相同幂等键重试");
        }
        return { ...(JSON.parse(existing.response_json) as T), replayed: true };
      }
      const timestamp = nowIso();
      let response: T | undefined;
      let failure: unknown;
      try {
        response = work();
      } catch (error) {
        failure = error;
      }
      try {
        if (failure) {
          this.db.prepare(`
            INSERT INTO operation_ledger
              (op_id, op_type, request_json, status, response_json, error_code, created_at, completed_at)
            VALUES (?, ?, ?, 'FAILED', NULL, ?, ?, ?)
          `).run(opId, opType, JSON.stringify(request), failure instanceof AppError ? failure.code : "INTERNAL_ERROR", timestamp, nowIso());
        } else {
          this.db.prepare(`
            INSERT INTO operation_ledger
              (op_id, op_type, request_json, status, response_json, error_code, created_at, completed_at)
            VALUES (?, ?, ?, 'COMPLETED', ?, NULL, ?, ?)
          `).run(opId, opType, JSON.stringify(request), JSON.stringify(response), timestamp, nowIso());
        }
      } catch (insertError) {
        if (isUniqueError(insertError)) {
          // 并发的相同 opId 已先提交：返回其结果
          const winner = this.db.prepare("SELECT * FROM operation_ledger WHERE op_id = ?").get(opId) as LedgerRow;
          if (winner.status === "COMPLETED" && winner.response_json) {
            return { ...(JSON.parse(winner.response_json) as T), replayed: true };
          }
        }
        throw insertError;
      }
      if (failure) throw failure;
      return response as T;
    });
  }

  private validateReason(reason: string | undefined): string {
    const value = reason ?? "MANUAL_VOID";
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(value)) {
      throw new AppError(422, "INVALID_REASON", "原因码必须为 1-32 位大写字母、数字或下划线，且以字母开头");
    }
    return value;
  }

  private transitionResult(batch: BatchRow, active: LabelRow | undefined, previous?: LabelRow): TransitionResult {
    return {
      batch: batchJson(batch),
      activeLabel: active ? labelJson(active) : undefined,
      previousLabel: previous ? labelJson(previous) : undefined
    };
  }

  /* ===== 批次登记（重复识别不建重复批次） ===== */

  register(input: RegisterInput, opId?: string): TransitionResult {
    if (!input.bizKey?.trim()) throw new AppError(422, "VALIDATION_ERROR", "bizKey 不能为空", { bizKey: ["不能为空"] });
    if (!input.sku?.trim()) throw new AppError(422, "VALIDATION_ERROR", "sku 不能为空", { sku: ["不能为空"] });
    if (input.quantity !== undefined && (!Number.isFinite(input.quantity) || input.quantity < 0)) {
      throw new AppError(422, "VALIDATION_ERROR", "quantity 必须是非负数", { quantity: ["必须是非负数"] });
    }

    const run = () => immediateTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM batches WHERE biz_key = ?").get(input.bizKey) as BatchRow | undefined;
      if (existing) {
        // 同一物理批次被重复识别（含离线补传）：返回已有批次与有效标签，绝不新建
        const active = this.db.prepare("SELECT * FROM labels WHERE batch_id = ? AND status = 'ACTIVE'")
          .get(existing.id) as LabelRow | undefined;
        return { ...this.transitionResult(existing, active), replayed: true as const };
      }

      const timestamp = nowIso();
      const batchId = `B-${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO batches (id, biz_key, sku, name, quantity, unit, attributes_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, input.bizKey, input.sku, input.name ?? null,
        input.quantity ?? null, input.unit ?? null,
        JSON.stringify(input.attributes ?? {}), timestamp, timestamp
      );
      const batch = this.getBatchRow(batchId);
      const label = this.issueLabel(batchId, input.memo, timestamp);
      return this.transitionResult(batch, label);
    });

    if (opId) {
      return this.withOp(opId, "REGISTER", input as unknown as Record<string, unknown>, run);
    }
    return run();
  }

  /* ===== 重印：旧标签失效（保留可重定向），同批次签发新标签 ===== */

  reprint(code: string, memo?: string, reason = "REPRINT", opId?: string): TransitionResult {
    const run = () => immediateTransaction(this.db, () => {
      const timestamp = nowIso();
      const previous = this.getLabelByCode(normalizeCode(code));
      if (previous.status !== "ACTIVE") {
        throw new AppError(409, "LABEL_NOT_ACTIVE", `标签当前状态为 ${previous.status}，不能重印`, {
          shortCode: ["只能对 ACTIVE 标签重印"]
        });
      }
      const { active, replaced } = this.replaceActive(previous, reason, memo, timestamp);
      return this.transitionResult(this.getBatchRow(previous.batch_id), active, replaced);
    });

    if (opId) {
      return this.withOp(opId, "REPRINT", { code, memo, reason }, run);
    }
    return run();
  }

  /* ===== 作废：标签永久失效，批次暂无有效标签（可后续换签恢复） ===== */

  void(code: string, reason?: string, memo?: string, opId?: string): TransitionResult {
    const reasonCode = this.validateReason(reason);
    if (reasonCode === "REPRINT" || reasonCode === "RETAG") {
      throw new AppError(422, "RESERVED_REASON", "REPRINT / RETAG 为保留原因码，请使用其他原因");
    }
    const run = () => immediateTransaction(this.db, () => {
      const timestamp = nowIso();
      const label = this.getLabelByCode(normalizeCode(code));
      if (label.status === "VOID") {
        // 作废天然幂等：已是 VOID 直接回显当前状态
        const batch = this.getBatchRow(label.batch_id);
        return { ...this.transitionResult(batch, undefined, label), replayed: true as const };
      }
      if (label.status === "SUPERSEDED") {
        throw new AppError(409, "LABEL_SUPERSEDED", "标签已被新标签替换，如需作废请作废当前有效标签");
      }
      this.db.prepare(`
        UPDATE labels SET status = 'VOID', replace_reason = ?, memo = COALESCE(?, memo), replaced_at = ?
        WHERE id = ?
      `).run(reasonCode, memo ?? null, timestamp, label.id);
      this.db.prepare("UPDATE batches SET updated_at = ? WHERE id = ?").run(timestamp, label.batch_id);
      const voided = this.db.prepare("SELECT * FROM labels WHERE id = ?").get(label.id) as LabelRow;
      return this.transitionResult(this.getBatchRow(label.batch_id), undefined, voided);
    });

    if (opId) {
      return this.withOp(opId, "VOID", { code, reason: reasonCode, memo }, run);
    }
    return run();
  }

  /* ===== 换签：物理标签/容器更换，旧码作废并重定向，同批次签发新码 ===== */

  retag(code: string, memo?: string, opId?: string): TransitionResult {
    const run = () => immediateTransaction(this.db, () => {
      const timestamp = nowIso();
      const previous = this.getLabelByCode(normalizeCode(code));
      if (previous.status !== "ACTIVE") {
        throw new AppError(409, "LABEL_NOT_ACTIVE", `标签当前状态为 ${previous.status}，不能换签`, {
          shortCode: ["只能对 ACTIVE 标签换签"]
        });
      }
      const { active, replaced } = this.replaceActive(previous, "RETAG", memo, timestamp);
      return this.transitionResult(this.getBatchRow(previous.batch_id), active, replaced);
    });

    if (opId) {
      return this.withOp(opId, "RETAG", { code, memo }, run);
    }
    return run();
  }

  /* ===== 短码解析（沿 replaced_by 链找到当前有效标签） ===== */

  resolve(rawCode: string) {
    let normalized: string;
    try {
      normalized = normalizeCode(rawCode);
    } catch {
      return { requestedCode: rawCode.replace(/\s/g, ""), scanResult: "BAD_CODE" as const };
    }

    const first = this.db.prepare("SELECT * FROM labels WHERE short_code = ?").get(normalized) as LabelRow | undefined;
    if (!first) {
      return { requestedCode: normalized, scanResult: "NOT_FOUND" as const };
    }

    const chain: ReturnType<typeof labelJson>[] = [];
    let current = first;
    chain.push(labelJson(current));
    while (current.replaced_by_id !== null) {
      const next = this.db.prepare("SELECT * FROM labels WHERE id = ?").get(current.replaced_by_id) as LabelRow | undefined;
      if (!next) break;
      current = next;
      chain.push(labelJson(current));
    }

    if (current.status === "ACTIVE") {
      const batch = this.getBatchRow(current.batch_id);
      return {
        requestedCode: normalized,
        scanResult: first.id === current.id ? ("OK" as const) : ("REDIRECTED" as const),
        batch: batchJson(batch),
        activeLabel: labelJson(current),
        chain
      };
    }
    return { requestedCode: normalized, scanResult: "VOIDED" as const, chain };
  }

  /* ===== 扫码定位（离线补传可重放；重复事件绝不产生重复批次/重复行） ===== */

  ingestScans(inputs: ScanInput[]) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 500) {
      throw new AppError(422, "VALIDATION_ERROR", "每次上传必须包含 1-500 条扫码事件");
    }

    const results = inputs.map((event) => {
      try {
        return immediateTransaction(this.db, () => this.ingestOne(event));
      } catch (error) {
        const message = error instanceof Error ? error.message : "扫码事件处理失败";
        const code = error instanceof AppError ? error.code : "SCAN_REJECTED";
        return { accepted: false as const, scanResult: "BAD_CODE" as const, errorCode: code, message };
      }
    });

    return {
      accepted: results.filter((r) => r.accepted).length,
      rejected: results.filter((r) => !r.accepted).length,
      results
    };
  }

  private ingestOne(event: ScanInput) {
    if (!event.deviceId?.trim()) {
      throw new AppError(422, "VALIDATION_ERROR", "deviceId 不能为空");
    }
    const scannedAt = parseClientIso(event.scannedAt, "scannedAt");
    if (event.latitude !== undefined && (event.latitude < -90 || event.latitude > 90)) {
      throw new AppError(422, "VALIDATION_ERROR", "latitude 必须在 -90 到 90 之间");
    }
    if (event.longitude !== undefined && (event.longitude < -180 || event.longitude > 180)) {
      throw new AppError(422, "VALIDATION_ERROR", "longitude 必须在 -180 到 180 之间");
    }

    const resolution = this.resolve(event.rawCode);
    if (resolution.scanResult === "BAD_CODE") {
      // 码本身无法通过校验位/长度检查：属于扫码误读，拒绝并要求终端重扫，不落库
      throw new AppError(422, "BAD_CODE", `无法识别的短码: ${event.rawCode}`);
    }
    const normalized = resolution.requestedCode;

    // 无 eventId 时由设备、码、扫码时间、站点、坐标派生确定性指纹
    const fingerprintSource = JSON.stringify([
      event.deviceId, normalized, scannedAt, event.station ?? null,
      event.latitude ?? null, event.longitude ?? null
    ]);
    const eventId = event.eventId?.trim() || `E-${createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 32)}`;

    const existing = this.db.prepare("SELECT * FROM scan_events WHERE event_id = ?").get(eventId) as ScanRow | undefined;
    if (existing) {
      // 离线补传重放：回传首次入库结果，不重复写入、不重复建批
      return { accepted: true as const, replayed: true as const, scan: scanJson(existing) };
    }

    const detail: Record<string, unknown> = {};
    let resolvedLabelId: number | null = null;
    let resolvedBatchId: string | null = null;
    if (resolution.scanResult === "OK" || resolution.scanResult === "REDIRECTED") {
      resolvedLabelId = resolution.activeLabel.id;
      resolvedBatchId = resolution.batch.id;
      detail.batch = resolution.batch;
      detail.activeLabel = resolution.activeLabel;
      detail.chain = resolution.chain;
    } else if (resolution.scanResult === "VOIDED") {
      detail.chain = resolution.chain;
    }

    this.db.prepare(`
      INSERT INTO scan_events (
        event_id, device_id, short_code, scanned_at, received_at, station,
        latitude, longitude, resolved_label_id, resolved_batch_id, scan_result, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, event.deviceId, normalized, scannedAt, nowIso(), event.station ?? null,
      event.latitude ?? null, event.longitude ?? null,
      resolvedLabelId, resolvedBatchId, resolution.scanResult, JSON.stringify(detail)
    );
    const row = this.db.prepare("SELECT * FROM scan_events WHERE event_id = ?").get(eventId) as ScanRow;
    return { accepted: true as const, replayed: false as const, scan: scanJson(row) };
  }

  /* ===== 查询 ===== */

  getBatch(batchId: string) {
    const batch = batchJson(this.getBatchRow(batchId));
    const labels = (this.db.prepare("SELECT * FROM labels WHERE batch_id = ? ORDER BY seq").all(batchId) as LabelRow[]).map(labelJson);
    const latest = this.latestLocationRow(batchId);
    return {
      ...batch,
      labels,
      // 序列化为 JSON 时 undefined 会丢键；始终给出 null 以保持响应结构稳定
      activeLabel: labels.find((l) => l.status === "ACTIVE") ?? null,
      latestLocation: latest ? this.locationJson(latest) : null
    };
  }

  private latestLocationRow(batchId: string): ScanRow | undefined {
    return this.db.prepare(`
      SELECT * FROM scan_events
       WHERE resolved_batch_id = ? AND scan_result IN ('OK', 'REDIRECTED')
       ORDER BY scanned_at DESC, received_at DESC
       LIMIT 1
    `).get(batchId) as ScanRow | undefined;
  }

  private locationJson(row: ScanRow) {
    return {
      eventId: row.event_id,
      deviceId: row.device_id,
      shortCode: row.short_code,
      scanResult: row.scan_result,
      station: row.station ?? undefined,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      scannedAt: row.scanned_at,
      receivedAt: row.received_at
    };
  }

  /** 当前定位：扫旧码产生的 REDIRECTED 事件同样代表该批次出现于该位置，纳入定位 */
  getLatestLocation(batchId: string) {
    this.getBatchRow(batchId); // 批次不存在则 404
    const latest = this.latestLocationRow(batchId);
    return { batchId, latestLocation: latest ? this.locationJson(latest) : null };
  }

  getHistory(batchId: string, limit = 50) {
    this.getBatchRow(batchId);
    const rows = this.db.prepare(`
      SELECT * FROM scan_events
       WHERE resolved_batch_id = ?
       ORDER BY scanned_at DESC, received_at DESC
       LIMIT ?
    `).all(batchId, Math.min(Math.max(limit, 1), 200)) as ScanRow[];
    return { batchId, events: rows.map(scanJson) };
  }
}
