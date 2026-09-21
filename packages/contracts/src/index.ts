import { z } from "zod";

export const craftTypes = ["DYEING", "WOODWORKING", "POTTERY", "METALWORKING", "GENERAL", "OTHER"] as const;
export type CraftType = (typeof craftTypes)[number];

export const sourceTypes = ["PURCHASED", "GIFTED", "SELF_MADE", "SALVAGED", "OTHER"] as const;
export type SourceType = (typeof sourceTypes)[number];

export const stockUnits = ["g", "kg", "ml", "l", "mm", "cm", "m", "m2", "pcs"] as const;
export type StockUnit = (typeof stockUnits)[number];

export const batchStatuses = ["PENDING", "ACTIVE", "DEPLETED", "ARCHIVED"] as const;
export type BatchStatus = (typeof batchStatuses)[number];

export const movementTypes = [
  "OPENING",
  "PURCHASE",
  "CONSUMPTION",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "REVERSAL"
] as const;
export type MovementType = (typeof movementTypes)[number];

export const projectStatuses = ["PLANNED", "IN_PROGRESS", "COMPLETED", "ARCHIVED"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const colorChangeTypes = [
  "OXIDATION",
  "DYE_BATH",
  "FINISHING",
  "GLAZE",
  "PATINA",
  "WEATHERING",
  "MIXING",
  "OTHER"
] as const;
export type ColorChangeType = (typeof colorChangeTypes)[number];

export const attachmentOwnerTypes = ["BATCH", "COLOR_CHANGE", "PROJECT", "CONSUMPTION"] as const;
export type AttachmentOwnerType = (typeof attachmentOwnerTypes)[number];

export const unitFamilies = {
  g: { family: "MASS", base: "g", factor: "1" },
  kg: { family: "MASS", base: "g", factor: "1000" },
  ml: { family: "VOLUME", base: "ml", factor: "1" },
  l: { family: "VOLUME", base: "ml", factor: "1000" },
  mm: { family: "LENGTH", base: "mm", factor: "1" },
  cm: { family: "LENGTH", base: "mm", factor: "10" },
  m: { family: "LENGTH", base: "mm", factor: "1000" },
  m2: { family: "AREA", base: "m2", factor: "1" },
  pcs: { family: "COUNT", base: "pcs", factor: "1" }
} as const satisfies Record<StockUnit, { family: string; base: StockUnit; factor: string }>;

export const decimalQuantity = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, "数量必须是最多 6 位小数的非负十进制数");
export const positiveQuantity = decimalQuantity.refine((value) => compareQuantities(value, "0") > 0, "数量必须大于 0");
export const moneyAmount = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, "金额必须是最多 2 位小数的非负十进制数");
export const colorHex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色必须是 #RRGGBB 格式");

const QUANTITY_SCALE = 1_000_000n;

function toScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("INVALID_QUANTITY");
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * QUANTITY_SCALE + BigInt(fraction || "0");
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / QUANTITY_SCALE;
  const fraction = (absolute % QUANTITY_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function quantitiesAreCompatible(left: StockUnit, right: StockUnit): boolean {
  return unitFamilies[left].family === unitFamilies[right].family;
}

export function convertQuantity(value: string, from: StockUnit, to: StockUnit): string {
  if (!quantitiesAreCompatible(from, to)) {
    throw new Error(`UNIT_INCOMPATIBLE:${from}:${to}`);
  }
  const fromFactor = BigInt(unitFamilies[from].factor);
  const toFactor = BigInt(unitFamilies[to].factor);
  const scaled = toScaled(value) * fromFactor;
  if (scaled % toFactor !== 0n) throw new Error("QUANTITY_PRECISION_EXCEEDED");
  return fromScaled(scaled / toFactor);
}

export function addQuantities(left: string, right: string): string {
  return fromScaled(toScaled(left) + toScaled(right));
}

export function subtractQuantities(left: string, right: string): string {
  return fromScaled(toScaled(left) - toScaled(right));
}

export function compareQuantities(left: string, right: string): number {
  const leftScaled = toScaled(left);
  const rightScaled = toScaled(right);
  return leftScaled === rightScaled ? 0 : leftScaled > rightScaled ? 1 : -1;
}

export const setupSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(10).max(128)
});

export const loginSchema = z.object({
  password: z.string().min(1).max(128)
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128)
});

export const sourceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(sourceTypes),
  contactName: z.string().trim().max(80).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  contactEmail: z.union([z.string().email().max(120), z.literal("")]).nullable().optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional()
});

export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});

export const materialInputSchema = z.object({
  code: z.string().trim().max(64).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  craftTypes: z.array(z.enum(craftTypes)).min(1),
  subtype: z.string().trim().max(80).nullable().optional(),
  stockUnit: z.enum(stockUnits),
  lowStockThreshold: decimalQuantity.nullable().optional(),
  defaultColorName: z.string().trim().max(80).nullable().optional(),
  defaultColorHex: z.union([colorHex, z.literal("")]).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  notes: z.string().trim().max(5000).nullable().optional()
});

export const batchCreateSchema = z.object({
  materialId: z.string().uuid(),
  batchCode: z.string().trim().max(64).nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  sourceNote: z.string().trim().max(200).nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  receivedAt: z.string().date(),
  expiryAt: z.string().date().nullable().optional(),
  initialQuantity: positiveQuantity,
  entryUnit: z.enum(stockUnits),
  totalCost: moneyAmount.nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "币种必须是 3 位字母代码").transform((value) => value.toUpperCase()).nullable().optional(),
  initialColorName: z.string().trim().max(80).nullable().optional(),
  initialColorHex: z.union([colorHex, z.literal("")]).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional()
});

export const batchPatchSchema = z.object({
  version: z.number().int().positive(),
  locationId: z.string().uuid().nullable().optional(),
  expiryAt: z.string().date().nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional()
});

export const adjustmentSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  quantity: positiveQuantity,
  unit: z.enum(stockUnits),
  reason: z.string().trim().min(3).max(1000),
  version: z.number().int().positive()
});

export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  craftType: z.enum(craftTypes),
  status: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED"]).default("PLANNED"),
  startDate: z.string().date().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  targetColorName: z.string().trim().max(80).nullable().optional(),
  targetColorHex: z.union([colorHex, z.literal("")]).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([])
});

export const requirementInputSchema = z.object({
  materialId: z.string().uuid(),
  requiredQuantity: positiveQuantity,
  unit: z.enum(stockUnits),
  purpose: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});

export const consumptionInputSchema = z.object({
  projectId: z.string().uuid(),
  projectRequirementId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid(),
  usedQuantity: decimalQuantity,
  wasteQuantity: decimalQuantity,
  unit: z.enum(stockUnits),
  consumedAt: z.string().datetime({ offset: true }).optional(),
  purpose: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
}).refine((value) => compareQuantities(value.usedQuantity, "0") > 0 || compareQuantities(value.wasteQuantity, "0") > 0, {
  message: "实际使用量与损耗量至少一项大于 0",
  path: ["usedQuantity"]
});

export const colorChangeInputSchema = z.object({
  batchId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  consumptionId: z.string().uuid().nullable().optional(),
  changeType: z.enum(colorChangeTypes),
  beforeColorName: z.string().trim().max(80).nullable().optional(),
  beforeColorHex: z.union([colorHex, z.literal("")]).nullable().optional(),
  afterColorName: z.string().trim().min(1).max(80),
  afterColorHex: z.union([colorHex, z.literal("")]).nullable().optional(),
  affectedQuantity: positiveQuantity.nullable().optional(),
  unit: z.enum(stockUnits).nullable().optional(),
  temperatureC: z.number().min(-100).max(2000).nullable().optional(),
  humidityPercent: z.number().min(0).max(100).nullable().optional(),
  phValue: z.number().min(0).max(14).nullable().optional(),
  environmentNotes: z.string().trim().max(3000).nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(3000).nullable().optional()
});

export const colorChangePatchSchema = z.object({
  environmentNotes: z.string().trim().max(3000).nullable().optional(),
  notes: z.string().trim().max(3000).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "至少提供一个可更新字段");

export const reverseConsumptionSchema = z.object({
  reason: z.string().trim().min(3).max(1000)
});

export const projectStatusSchema = z.object({
  status: z.enum(projectStatuses),
  version: z.number().int().positive()
});

export type Pagination = {
  page: number;
  pageSize: number;
  total: number;
};

// ---------------------------------------------------------------------------
// 批次标签（短码）与扫码定位
// ---------------------------------------------------------------------------

export const labelStatuses = ["ACTIVE", "VOIDED", "REPLACED"] as const;
export type LabelStatus = (typeof labelStatuses)[number];

export const scanResults = ["OK", "REPLACED", "VOIDED", "UNKNOWN"] as const;
export type ScanResult = (typeof scanResults)[number];

// 短码：8 位 Crockford Base32（不含 I L O U，末位为校验位），服务端生成。
export const shortCodePattern = /^[0-9A-HJ-KM-NP-TV-Z]{8}$/;
export const shortCodeInput = z
  .string()
  .trim()
  .toUpperCase()
  .regex(shortCodePattern, "短码必须是 8 位数字与大写字母");

export const labelReprintSchema = z.object({
  reason: z.string().trim().max(200).nullable().optional()
});

export const labelVoidSchema = z.object({
  reason: z.string().trim().min(2, "作废原因至少 2 个字符").max(200)
});

export const labelReplaceSchema = z.object({
  reason: z.string().trim().min(2, "换签原因至少 2 个字符").max(200)
});

const locationFields = {
  locationName: z.string().trim().max(120).nullable().optional(),
  latitude: z.number().gte(-90).lte(90).nullable().optional(),
  longitude: z.number().gte(-180).lte(180).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
};

const scanBaseShape = {
  eventId: z.string().uuid("事件 ID 必须是 UUID"),
  shortCode: shortCodeInput,
  scannedAt: z.string().datetime({ offset: true }),
  deviceId: z.string().trim().min(1).max(80).optional(),
  operator: z.string().trim().max(80).nullable().optional(),
  ...locationFields
};
const refineScanLocation = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(
    (value: { latitude?: number | null; longitude?: number | null }) =>
      (value.latitude === null || value.latitude === undefined) === (value.longitude === null || value.longitude === undefined),
    { message: "经纬度必须同时提供", path: ["longitude"] }
  );

// 在线单条扫码必须自带设备号。
export const scanInputSchema = refineScanLocation(z.object(scanBaseShape).refine((value) => value.deviceId !== undefined, {
  message: "deviceId 不能为空",
  path: ["deviceId"]
}));

// 离线补传：设备号可用包级 deviceId 兜底。
export const syncScanSchema = refineScanLocation(z.object(scanBaseShape));

// 离线识别到的批次（OCR / 手工录入）：按 (材料, 批次号) 自然键幂等创建。
export const batchRecognitionSchema = z.object({
  eventId: z.string().uuid("事件 ID 必须是 UUID"),
  materialId: z.string().uuid(),
  batchCode: z.string().trim().min(1).max(64),
  receivedAt: z.string().date().optional(),
  deviceId: z.string().trim().min(1).max(80),
  recognizedAt: z.string().datetime({ offset: true })
});

export const syncPayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(80),
  scans: z.array(syncScanSchema).max(2000).default([]),
  recognitions: z.array(batchRecognitionSchema).max(1000).default([])
}).refine((value) => value.scans.length > 0 || value.recognitions.length > 0, {
  message: "补传至少包含一条扫码或识别记录",
  path: ["scans"]
});
