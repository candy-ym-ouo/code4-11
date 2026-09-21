import { describe, expect, it } from "vitest";
import { generateShortCode, normalizeShortCode, formatShortCode } from "../src/lib/shortcode.js";

describe("short code", () => {
  it("generates codes with valid check digits", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateShortCode();
      expect(code).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{8}$/);
      expect(normalizeShortCode(code)).toBe(code);
    }
  });

  it("tolerates lowercase, dashes and common OCR misreads", () => {
    const code = generateShortCode();
    const lower = code.toLowerCase().replace(/(\w{4})(\w{4})/, "$1-$2");
    expect(normalizeShortCode(lower)).toBe(code);

    // 0 <-> O、1 <-> I/L 误读归一化（映射后若校验位也随之合法才通过）。
    const withMisread = code.replace(/0/g, "O").replace(/1/g, "I");
    expect(normalizeShortCode(withMisread)).toBe(code);
  });

  it("rejects wrong check digits and malformed input", () => {
    const code = generateShortCode();
    const last = code[7]!;
    const replacement = last === "0" ? "2" : "0";
    expect(normalizeShortCode(code.slice(0, 7) + replacement)).toBeNull();
    expect(normalizeShortCode("")).toBeNull();
    expect(normalizeShortCode("ABC")).toBeNull();
  });

  it("formats codes as two groups of four", () => {
    const code = generateShortCode();
    expect(formatShortCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
  });
});
