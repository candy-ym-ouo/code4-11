/** ISO8601 UTC 时间（秒级精度即可，统一 Z 后缀） */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 解析客户端时间：接受 ...Z（秒/毫秒）或 +08:00 偏移，统一输出 UTC ISO。
 * 离线扫码时间由设备时钟提供，拒绝非法时间以免污染时间线。
 */
export function parseClientIso(raw: string, field = "时间"): string {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(`${field}必须是 ISO8601 时间（如 2026-09-21T08:30:00Z）`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${field}无法解析`);
  return nowIso(new Date(timestamp));
}
