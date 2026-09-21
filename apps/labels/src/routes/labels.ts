import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LabelService, type ScanInput } from "../service.js";
import { AppError } from "../lib/errors.js";

/* ---------------- 校验 ---------------- */

const registerSchema = z.object({
  bizKey: z.string().trim().min(1).max(128),
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().finite().nonnegative().optional(),
  unit: z.string().trim().min(1).max(16).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  memo: z.string().trim().min(1).max(200).optional()
});

const reprintSchema = z.object({
  memo: z.string().trim().min(1).max(200).optional(),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).default("REPRINT")
});

const voidSchema = z.object({
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).optional(),
  memo: z.string().trim().min(1).max(200).optional()
});

const retagSchema = z.object({
  memo: z.string().trim().min(1).max(200).optional()
});

const scanSchema = z.object({
  eventId: z.string().trim().min(1).max(100).optional(),
  deviceId: z.string().trim().min(1).max(64),
  rawCode: z.string().trim().min(1).max(64),
  scannedAt: z.string().min(20).max(40),
  station: z.string().trim().min(1).max(100).optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional()
});

const scansSchema = z.object({
  events: z.array(scanSchema).min(1).max(500)
});

function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "body";
      (fieldErrors[field] ??= []).push(issue.message);
    }
    throw new AppError(422, "VALIDATION_ERROR", "请求参数不符合要求", fieldErrors);
  }
  return result.data;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new AppError(422, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 必须是 1-100 个字符的字符串");
  }
  return value.trim();
}

function parseCodeParam(request: FastifyRequest): string {
  const code = (request.params as { code?: string }).code ?? "";
  const parsed = z.string().trim().min(1).max(64).safeParse(code);
  if (!parsed.success) throw new AppError(422, "VALIDATION_ERROR", "短码参数无效", { code: ["短码格式无效"] });
  return parsed.data;
}

/* ---------------- 路由 ---------------- */

export async function labelRoutes(app: FastifyInstance): Promise<void> {
  const service = (): LabelService => app.labelService;

  // 批次登记：重复识别返回既有批次（replayed），不创建重复批次
  app.post("/v1/batches", async (request, reply) => {
    const input = parseBody(registerSchema, request);
    const result = service().register(input, idempotencyKey(request));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });

  // 重印：旧码置为 SUPERSEDED 并可重定向，签发新码
  app.post("/v1/labels/:code/reprint", async (request) => {
    const input = parseBody(reprintSchema, request);
    return service().reprint(parseCodeParam(request), input.memo, input.reason, idempotencyKey(request));
  });

  // 作废：标签永久 VOID，批次无有效标签
  app.post("/v1/labels/:code/void", async (request) => {
    const input = parseBody(voidSchema, request);
    return service().void(parseCodeParam(request), input.reason, input.memo, idempotencyKey(request));
  });

  // 换签：物理标签更换，旧码重定向到新码
  app.post("/v1/labels/:code/retag", async (request) => {
    const input = parseBody(retagSchema, request);
    return service().retag(parseCodeParam(request), input.memo, idempotencyKey(request));
  });

  // 扫码解析：查短码当前指向（不写事件）
  app.get("/v1/labels/:code/resolve", async (request) => {
    return service().resolve(parseCodeParam(request));
  });

  // 扫码定位事件上报：支持离线批量补传，按 eventId/指纹去重，可安全重放
  app.post("/v1/scans", async (_request, reply) => {
    const { events } = parseBody(scansSchema, _request);
    const result = service().ingestScans(events as ScanInput[]);
    // 即使部分/全部事件被拒也返回 200，逐条给出错误，便于离线端保留并重试
    reply.code(200);
    return result;
  });

  // 批次当前定位
  app.get("/v1/batches/:id/location", async (request) => {
    return service().getLatestLocation((request.params as { id: string }).id);
  });

  // 批次扫码轨迹
  app.get("/v1/batches/:id/history", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "50");
    return service().getHistory((request.params as { id: string }).id, Number.isFinite(limit) ? limit : 50);
  });

  // 批次聚合（标签链 + 最新定位）
  app.get("/v1/batches/:id", async (request) => {
    return service().getBatch((request.params as { id: string }).id);
  });
}
