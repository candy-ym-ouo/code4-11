import { randomInt } from "node:crypto";

/**
 * 标签短码：Crockford base32，7 位随机负载 + 1 位校验位（共 8 位）。
 * 不使用易混淆字符 I/L/O/U；扫码归一化时 I/i -> 1、L/l -> 1、O/o -> 0、连字符剔除。
 * 约 32^7 ≈ 340 亿空间，签发时库内去重重试。
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;
const PAYLOAD_LENGTH = CODE_LENGTH - 1;

function charValue(char: string): number {
  const value = ALPHABET.indexOf(char);
  if (value < 0) throw new Error(`非法字符: ${char}`);
  return value;
}

/** 加权校验和 mod 32，防止一位扫码误读 */
export function checkDigit(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    sum += (i + 1) * charValue(payload[i] as string);
  }
  return ALPHABET[sum % ALPHABET.length] as string;
}

export function generateShortCode(): string {
  const payload = Array.from({ length: PAYLOAD_LENGTH }, () =>
    ALPHABET[randomInt(ALPHABET.length)]
  ).join("");
  return payload + checkDigit(payload);
}

/**
 * 归一化扫码输入：去空白与连字符、大写、视觉歧义字符映射。
 * 归一化后再做长度与校验位检查，任何一关失败即 BAD_CODE。
 */
export function normalizeCode(raw: string): string {
  let code = raw.replace(/[\s-]/g, "").toUpperCase();
  code = code.replace(/[IL]/g, "1").replace(/O/g, "0");
  if (code.length !== CODE_LENGTH) {
    throw new Error(`短码长度必须为 ${CODE_LENGTH} 位`);
  }
  for (const char of code) {
    if (!ALPHABET.includes(char)) throw new Error(`短码含非法字符: ${char}`);
  }
  const payload = code.slice(0, PAYLOAD_LENGTH);
  if (checkDigit(payload) !== code[PAYLOAD_LENGTH]) {
    throw new Error("短码校验位不正确");
  }
  return code;
}
