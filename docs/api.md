# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。

## 10. 批次标签（短码）

短码为 8 位 Crockford Base32（`0-9A-HJ-KM-NP-TV-Z`，剔除易混字符），末位为校验位；
接口接受小写、连字符以及 `0/O`、`1/I/L` 的扫码误读，自动归一化。短码一经签发永不改变、
永不回收；标签状态机为 `ACTIVE → REPRINT（印次+1）/ VOID / REPLACE`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/batches/:id/labels` | 为批次签发标签（每批至多一枚 ACTIVE） |
| GET | `/batches/:id/labels` | 该批次全部标签（含已作废、已换签） |
| GET | `/labels/:code` | 标签详情与事件历史 |
| POST | `/labels/:code/reprint` | 重印：短码不变，`printSeq` +1 |
| POST | `/labels/:code/void` | 作废：`{ "reason": "..." }` |
| POST | `/labels/:code/replace` | 换签：旧签置 REPLACED 并指向新签 |
| GET | `/resolve/:code` | 只解析不落事件，返回当前定位结论 |

换签会形成 predecessor → successor 链，扫旧码沿链返回最新有效签：

- `OK`：当前有效签，直接定位批次。
- `REPLACED`：该签已被换签，`effectiveLabel` 指向当前签，批次不变。
- `VOIDED`：该签（或其换签链终点）已作废。
- `UNKNOWN`：校验位合法但库里不存在。

重印、作废、换签均支持 `Idempotency-Key`；对已作废签重复作废、对已换签旧码重复换签均幂等。

## 11. 扫码定位与离线补传

所有离线事件以客户端生成的 UUID `eventId` 去重；解析结论在首次入库时冻结，
之后标签再被作废或换签也不改变历史结论。整包补传可任意重放，不会产生重复数据。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/scans` | 在线单条扫码 |
| POST | `/recognitions` | 识别批次（OCR/手工录入），按自然键幂等建档 |
| POST | `/sync` | 离线补传（扫码 + 识别混合包） |
| POST | `/sync/status` | 按 `eventIds` 查询是否已入库 |
| GET | `/batches/:id/scans` | 批次扫码轨迹（分页） |
| GET | `/batches/:id/last-seen` | 最近一次有效扫码位置 |

扫码事件：

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "shortCode": "3SYQV92P",
  "scannedAt": "2026-09-20T08:00:00+08:00",
  "deviceId": "PDA-42",
  "operator": "张三",
  "locationName": "染坊 A 区",
  "latitude": 31.2304,
  "longitude": 121.4737
}
```

离线补传包：`scans[].deviceId` 可省略，自动用包级 `deviceId` 兜底。服务端逐条用
SAVEPOINT 处理：单条失败只回滚该条并在响应中标记 `FAILED`，不影响其他条目。

```json
{
  "deviceId": "PDA-42",
  "scans": [ { "eventId": "...", "shortCode": "...", "scannedAt": "..." } ],
  "recognitions": [
    { "eventId": "...", "materialId": "uuid", "batchCode": "RC-001",
      "receivedAt": "2026-09-20", "recognizedAt": "2026-09-20T11:00:00+08:00" }
  ]
}
```

响应中每条带 `APPLIED` / `DUPLICATE` / `FAILED` 状态，并有 `summary` 汇总。

### 识别不产生重复批次

识别以 `(材料, 批次号)`（大小写不敏感）为自然键：首次识别创建 `PENDING` 批次
（数量 0、`recognizedAt` 记录识别时间）；之后无论是重复事件重放、不同设备、离线补传
还是并发请求，都只返回同一批次。正式调用 `POST /batches` 入库时激活该 PENDING 批次
（状态转 `ACTIVE`、写入初始数量与 OPENING 流水），不会新建第二条；对已存在的正式批次
重复入库返回 `409 BATCH_CODE_EXISTS`。
