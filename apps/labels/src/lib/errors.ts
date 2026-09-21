import type { FastifyReply } from "fastify";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {}
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** SQLite 写锁竞争（SQLITE_BUSY），调用方应提示重试 */
export function isBusyError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: string }).code === "SQLITE_BUSY";
}

/** 唯一约束冲突（含 op_id、biz_key、short_code、一一批一活动标签） */
export function isUniqueError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export function sendError(reply: FastifyReply, error: unknown, requestId: string): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        fieldErrors: error.fieldErrors,
        requestId
      }
    });
    return;
  }

  if (isBusyError(error)) {
    reply.status(409).send({
      error: {
        code: "CONCURRENT_TRANSACTION",
        message: "数据正在被其他操作修改，请重试",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  if (isUniqueError(error)) {
    reply.status(409).send({
      error: {
        code: "DUPLICATE_DATA",
        message: "数据已存在或与现有状态冲突",
        fieldErrors: {},
        requestId
      }
    });
    return;
  }

  reply.status(500).send({
    error: { code: "INTERNAL_ERROR", message: "服务器处理失败", fieldErrors: {}, requestId }
  });
}
