import { randomInt } from "node:crypto";

// Crockford Base32，剔除易混字符 I/L/O/U；扫码时对 0/O、1/I/L 的容错在 normalizeShortCode 处理。
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_CODE_LENGTH = 8;
const RANDOM_LENGTH = SHORT_CODE_LENGTH - 1; // 末位为校验位
const SHORT_CODE_PATTERN = /^[0-9A-HJ-KM-NP-TV-Z]{8}$/;

function checkDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    sum += ALPHABET.indexOf(body[i]!) * (i + 1);
  }
  return ALPHABET[sum % ALPHABET.length]!;
}

/** 生成随机短码（含校验位）；调用方需自行做唯一冲突重试。 */
export function generateShortCode(): string {
  let body = "";
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return body + checkDigit(body);
}

/** 扫码输入容错：小写、常见误读字符归一化；返回 null 表示格式或校验位不合法。 */
export function normalizeShortCode(raw: string): string | null {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (!SHORT_CODE_PATTERN.test(normalized)) return null;
  const body = normalized.slice(0, RANDOM_LENGTH);
  if (checkDigit(body) !== normalized[SHORT_CODE_LENGTH - 1]) return null;
  return normalized;
}

export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export { SHORT_CODE_PATTERN };
