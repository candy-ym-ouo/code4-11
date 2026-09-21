import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { LabelService, type ScanInput } from "../src/service.js";
import { generateShortCode, normalizeCode } from "../src/lib/code.js";
import { runMigrations } from "../src/migrate.js";
import type { Db } from "../src/lib/db.js";

let db: Db;
let service: LabelService;

function scan(overrides: Partial<ScanInput> & { rawCode: string; scannedAt: string }): ScanInput {
  return { deviceId: "PDA-01", ...overrides };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  service = new LabelService(db);
});

afterEach(() => db.close());

describe("短码", () => {
  it("生成 8 位 Crockford 码并通过自身校验", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateShortCode();
      expect(code).toHaveLength(8);
      expect(normalizeCode(code)).toBe(code);
    }
  });

  it("归一化视觉歧义字符与连字符", () => {
    const code = generateShortCode();
    // 插入连字符、小写，I/L 视同为 1、O 视同为 0
    const noisy = `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`;
    expect(normalizeCode(noisy)).toBe(code);
  });

  it("校验位错误或长度错误被拒绝", () => {
    const code = generateShortCode().split("");
    const last = code[7] as string;
    code[7] = last === "0" ? "1" : "0";
    expect(() => normalizeCode(code.join(""))).toThrow();
    expect(() => normalizeCode("ABC")).toThrow();
  });
});

describe("批次登记与重复识别", () => {
  it("登记即签发唯一 ACTIVE 标签", () => {
    const result = service.register({ bizKey: "batch-1", sku: "DYE-RED" });
    expect(result.batch.bizKey).toBe("batch-1");
    expect(result.activeLabel?.status).toBe("ACTIVE");
    expect(result.activeLabel?.seq).toBe(1);
    expect(result.replayed).toBeUndefined();
  });

  it("同一 bizKey 重复识别不创建重复批次", () => {
    const first = service.register({ bizKey: "batch-1", sku: "DYE-RED" });
    const second = service.register({ bizKey: "batch-1", sku: "DYE-RED", name: "再次识别" });
    expect(second.batch.id).toBe(first.batch.id);
    expect(second.replayed).toBe(true);
    expect(second.activeLabel?.shortCode).toBe(first.activeLabel?.shortCode);
    expect(db.prepare("SELECT count(*) AS c FROM batches").get() as { c: number }).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM labels").get() as { c: number }).toMatchObject({ c: 1 });
  });

  it("带 Idempotency-Key 的登记重放返回首次结果", () => {
    const first = service.register({ bizKey: "k", sku: "S" }, "op-1");
    const replay = service.register({ bizKey: "k", sku: "S" }, "op-1");
    expect(replay.batch.id).toBe(first.batch.id);
    expect(replay.replayed).toBe(true);
    expect(db.prepare("SELECT count(*) AS c FROM operation_ledger WHERE op_id = 'op-1'").get() as { c: number })
      .toMatchObject({ c: 1 });
  });
});

describe("重印", () => {
  it("旧标签 SUPERSEDED 可重定向，新标签 ACTIVE，一批一活动标签不变量成立", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const oldCode = reg.activeLabel!.shortCode;
    const result = service.reprint(oldCode, "打印机卡纸补打");
    expect(result.previousLabel?.status).toBe("SUPERSEDED");
    expect(result.previousLabel?.replaceReason).toBe("REPRINT");
    expect(result.previousLabel?.replacedById).toBe(result.activeLabel?.id);
    expect(result.activeLabel?.seq).toBe(2);
    expect(result.activeLabel?.shortCode).not.toBe(oldCode);

    const resolution = service.resolve(oldCode);
    expect(resolution.scanResult).toBe("REDIRECTED");
    expect(resolution.activeLabel?.shortCode).toBe(result.activeLabel?.shortCode);

    const count = db.prepare("SELECT count(*) AS c FROM labels WHERE batch_id = ? AND status = 'ACTIVE'")
      .get(result.batch.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it("同一 opId 重放重印不会签发第二张新标签", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const a = service.reprint(reg.activeLabel!.shortCode, undefined, "REPRINT", "reprint-1");
    const b = service.reprint(reg.activeLabel!.shortCode, undefined, "REPRINT", "reprint-1");
    expect(b.activeLabel?.id).toBe(a.activeLabel?.id);
    expect(b.replayed).toBe(true);
    expect(db.prepare("SELECT count(*) AS c FROM labels WHERE batch_id = ?").get(reg.batch.id) as { c: number })
      .toMatchObject({ c: 2 });
  });

  it("不能对已重印/已作废标签再次重印", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const reprinted = service.reprint(reg.activeLabel!.shortCode);
    expect(() => service.reprint(reg.activeLabel!.shortCode)).toThrowError(
      expect.objectContaining({ code: "LABEL_NOT_ACTIVE" })
    );
    expect(() => service.reprint(reprinted.activeLabel!.shortCode)).not.toThrow();
  });
});

describe("作废", () => {
  it("标签 VOID 后批次无有效标签，扫码返回 VOIDED", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const result = service.void(reg.activeLabel!.shortCode, "DAMAGED", "污损");
    expect(result.previousLabel?.status).toBe("VOID");
    expect(result.activeLabel).toBeUndefined();
    expect(service.resolve(reg.activeLabel!.shortCode).scanResult).toBe("VOIDED");
    expect(service.getBatch(reg.batch.id).activeLabel).toBeNull();
  });

  it("重复作废幂等回显", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    service.void(reg.activeLabel!.shortCode, "DAMAGED");
    const again = service.void(reg.activeLabel!.shortCode, "DAMAGED");
    expect(again.replayed).toBe(true);
    expect(db.prepare("SELECT count(*) AS c FROM labels").get() as { c: number }).toMatchObject({ c: 1 });
  });

  it("保留原因码 REPRINT/RETAG 不能用于作废", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    try {
      service.void(reg.activeLabel!.shortCode, "REPRINT");
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("RESERVED_REASON");
    }
  });
});

describe("换签", () => {
  it("旧码 RETAG 替换并重定向到新码，批次身份不变", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const oldCode = reg.activeLabel!.shortCode;
    const result = service.retag(oldCode, "换容器");
    expect(result.previousLabel?.replaceReason).toBe("RETAG");
    expect(result.batch.id).toBe(reg.batch.id);
    expect(result.activeLabel?.seq).toBe(2);
    expect(service.resolve(oldCode).scanResult).toBe("REDIRECTED");
    expect(service.resolve(result.activeLabel!.shortCode).scanResult).toBe("OK");
  });

  it("作废后的标签不能换签（VOID 无后继链，无法重定向）", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    service.void(reg.activeLabel!.shortCode, "DAMAGED");
    try {
      service.retag(reg.activeLabel!.shortCode);
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("LABEL_NOT_ACTIVE");
    }
  });
});

describe("扫码定位与离线补传", () => {
  const t1 = "2026-09-20T08:00:00Z";
  const t2 = "2026-09-20T10:30:00Z";
  const t3 = "2026-09-20T12:00:00Z";

  it("OK 扫码更新最新定位，旧码 REDIRECTED 也纳入定位", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const reprinted = service.reprint(reg.activeLabel!.shortCode);

    service.ingestScans([
      scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: t1, station: "A 仓" }), // 旧码 -> REDIRECTED
      scan({ rawCode: reprinted.activeLabel!.shortCode, scannedAt: t2, station: "B 仓", latitude: 31.2, longitude: 121.5 })
    ]);

    const location = service.getLatestLocation(reg.batch.id);
    expect(location.latestLocation?.station).toBe("B 仓");
    expect(location.latestLocation?.scanResult).toBe("OK");

    const history = service.getHistory(reg.batch.id);
    expect(history.events).toHaveLength(2);
    expect(history.events[1]?.scanResult).toBe("REDIRECTED");
  });

  it("事件重放（相同 eventId）不产生重复事件", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const payload = {
      events: [scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: t1, station: "A 仓", eventId: "evt-1" })]
    };
    const first = service.ingestScans(payload.events);
    const second = service.ingestScans(payload.events);
    expect(first.results[0]).toMatchObject({ accepted: true, replayed: false });
    expect(second.results[0]).toMatchObject({ accepted: true, replayed: true });
    expect(db.prepare("SELECT count(*) AS c FROM scan_events").get() as { c: number }).toMatchObject({ c: 1 });
  });

  it("无 eventId 时按字段指纹去重", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const event = scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: t1, station: "A 仓" });
    service.ingestScans([event]);
    const replay = service.ingestScans([{ ...event, rawCode: `${event.rawCode.slice(0, 4)}-${event.rawCode.slice(4).toLowerCase()}` }]);
    expect(replay.results[0]).toMatchObject({ accepted: true, replayed: true });
    expect(db.prepare("SELECT count(*) AS c FROM scan_events").get() as { c: number }).toMatchObject({ c: 1 });
  });

  it("作废码、不存在码、校验位错误码逐条拒绝且不影响同批其他事件", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    service.void(reg.activeLabel!.shortCode, "DAMAGED");
    const bad = generateShortCode().split("");
    bad[7] = bad[7] === "0" ? "1" : "0";

    const result = service.ingestScans([
      scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: t1 }), // VOIDED 接受但不定位
      scan({ rawCode: generateShortCode(), scannedAt: t2 }),       // NOT_FOUND
      scan({ rawCode: bad.join(""), scannedAt: t3 })               // BAD_CODE
    ]);
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.results.map((r) => r.scan?.scanResult ?? r.scanResult))
      .toEqual(["VOIDED", "NOT_FOUND", "BAD_CODE"]);
    expect(service.getLatestLocation(reg.batch.id).latestLocation).toBeNull();
  });

  it("离线乱序补传后按扫码时间而非接收时间排序定位", async () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const code = reg.activeLabel!.shortCode;
    // 先补传较晚的事件，再补传较早的事件
    service.ingestScans([scan({ rawCode: code, scannedAt: t3, station: "C 仓" })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.ingestScans([scan({ rawCode: code, scannedAt: t2, station: "B 仓" })]);
    expect(service.getLatestLocation(reg.batch.id).latestLocation?.station).toBe("C 仓");
  });

  it("非法时间与越界坐标被逐条拒绝", () => {
    const reg = service.register({ bizKey: "b", sku: "s" });
    const result = service.ingestScans([
      scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: "not-a-time" }),
      scan({ rawCode: reg.activeLabel!.shortCode, scannedAt: t1, latitude: 91 })
    ]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(2);
  });
});
