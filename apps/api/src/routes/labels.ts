import type { FastifyInstance } from "fastify";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";
import { labelReplaceSchema, labelReprintSchema, labelVoidSchema } from "@handcraft/contracts";
import { issueLabel, reprintLabel, voidLabel, replaceLabel, type LabelRow } from "../lib/labels.js";
import { normalizeShortCode } from "../lib/shortcode.js";

function requireShortCode(raw: string): string {
  const code = normalizeShortCode(raw);
  if (!code) throw new AppError(422, "INVALID_SHORT_CODE", "短码格式或校验位不正确");
  return code;
}

const labelSelect = `
  l.id, l.short_code AS "shortCode", l.batch_id AS "batchId", l.status,
  l.print_seq AS "printSeq", l.predecessor_id AS "predecessorId",
  l.successor_id AS "successorId", l.issued_at AS "issuedAt",
  l.voided_at AS "voidedAt", l.void_reason AS "voidReason",
  l.created_at AS "createdAt", l.updated_at AS "updatedAt"`;

async function loadLabelOrThrow(shortCode: string): Promise<LabelRow> {
  const result = await pool.query<LabelRow>(
    `SELECT ${labelSelect} FROM batch_labels l WHERE short_code = $1::char(8)`,
    [shortCode]
  );
  if (!result.rows[0]) throw new AppError(404, "LABEL_NOT_FOUND", "标签不存在");
  return result.rows[0];
}

export async function labelRoutes(app: FastifyInstance): Promise<void> {
  // 为批次签发短码标签。
  app.post<{ Params: { id: string } }>("/batches/:id/labels", async (request, reply) => {
    parseInput(labelReprintSchema, request.body ?? {});
    const body = (request.body as { reason?: string | null } | null) ?? {};
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const result = await withTransaction(async (client) => {
      const issued = await issueLabel(client, {
        batchId: request.params.id,
        actorUserId: user.id,
        clientRequestId: key,
        reason: body.reason ?? undefined
      });
      if (!issued.idempotent) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "LABEL_ISSUE",
          entityType: "BATCH_LABEL",
          entityId: issued.label.id,
          afterData: issued.label,
          requestId: request.id
        });
      }
      return issued;
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: result.label });
  });

  app.get("/labels/:shortCode", async (request) => {
    const code = requireShortCode((request.params as { shortCode: string }).shortCode);
    const label = await loadLabelOrThrow(code);
    const events = await pool.query(
      `SELECT e.id, e.action, e.reason, e.successor_id AS "successorId",
              e.created_at AS "createdAt", u.display_name AS "actorName"
         FROM label_events e JOIN users u ON u.id = e.actor_user_id
        WHERE e.label_id = $1 OR e.successor_id = $1
        ORDER BY e.created_at DESC`,
      [label.id]
    );
    const batch = await pool.query(
      `SELECT b.id, b.batch_code AS "batchCode", b.status AS "batchStatus",
              m.id AS "materialId", m.name AS "materialName"
         FROM batches b JOIN materials m ON m.id = b.material_id
        WHERE b.id = $1`,
      [label.batchId]
    );
    return { data: { ...label, batch: batch.rows[0] ?? null, events: events.rows } };
  });

  app.post("/labels/:shortCode/reprint", async (request, reply) => {
    const code = requireShortCode((request.params as { shortCode: string }).shortCode);
    const input = parseInput(labelReprintSchema, request.body ?? {});
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const result = await withTransaction(async (client) => {
      const reprinted = await reprintLabel(client, {
        shortCode: code,
        actorUserId: user.id,
        clientRequestId: key,
        reason: input.reason ?? undefined
      });
      if (!reprinted.idempotent) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "LABEL_REPRINT",
          entityType: "BATCH_LABEL",
          entityId: reprinted.label.id,
          afterData: reprinted.label,
          requestId: request.id
        });
      }
      return reprinted;
    });
    return reply.status(result.idempotent ? 200 : 201).send({ data: result.label });
  });

  app.post("/labels/:shortCode/void", async (request) => {
    const code = requireShortCode((request.params as { shortCode: string }).shortCode);
    const input = parseInput(labelVoidSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    return withTransaction(async (client) => {
      const voided = await voidLabel(client, {
        shortCode: code,
        reason: input.reason,
        actorUserId: user.id,
        clientRequestId: key
      });
      if (!voided.idempotent) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "LABEL_VOID",
          entityType: "BATCH_LABEL",
          entityId: voided.label.id,
          afterData: voided.label,
          requestId: request.id
        });
      }
      return { data: voided.label };
    });
  });

  app.post("/labels/:shortCode/replace", async (request, reply) => {
    const code = requireShortCode((request.params as { shortCode: string }).shortCode);
    const input = parseInput(labelReplaceSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const key = getIdempotencyKey(request.headers);
    const result = await withTransaction(async (client) => {
      const replaced = await replaceLabel(client, {
        shortCode: code,
        reason: input.reason,
        actorUserId: user.id,
        clientRequestId: key
      });
      if (!replaced.idempotent) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "LABEL_REPLACE",
          entityType: "BATCH_LABEL",
          entityId: replaced.oldLabel.id,
          afterData: { old: replaced.oldLabel, successor: replaced.label },
          requestId: request.id
        });
      }
      return replaced;
    });
    return reply.status(result.idempotent ? 200 : 201).send({
      data: { old: result.oldLabel, successor: result.label }
    });
  });

  app.get<{ Params: { id: string } }>("/batches/:id/labels", async (request) => {
    const result = await pool.query(
      `SELECT ${labelSelect} FROM batch_labels l
        WHERE l.batch_id = $1 ORDER BY l.issued_at DESC, l.created_at DESC`,
      [request.params.id]
    );
    return { data: result.rows };
  });
}
