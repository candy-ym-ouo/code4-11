# 批次标签与扫码定位服务

为批次签发可扫码的短码标签，支持 **重印、作废、换签**；扫码事件支持 **离线批量补传与安全重放**，
重复识别不会创建重复批次。

## 模型与核心不变量

```
batches 1───* labels            一个批次可拥有多代标签（重印/换签产生新代）
                │
                └─ replaced_by 指向下一代（旧码扫码沿链重定向）

scan_events  *───1 batches/labels   扫码定位事件（含 OK / REDIRECTED / VOIDED / NOT_FOUND / BAD_CODE）
operation_ledger                   写操作幂等账本（Idempotency-Key -> 首次响应）
```

- **一批至多一张 ACTIVE 标签**：由部分唯一索引 `ux_labels_one_active` 在数据库层强制，
  重印/换签按"旧标签先让位 → 插入新标签 → 回填 replaced_by"的顺序进行。
- **批次身份不随标签变化**：重印/换签只换标签码，`batchId` 与扫码历史保持连续。
- **重复识别不建批**：批次以稳定业务键 `bizKey` 唯一约束；同一 `bizKey` 再次登记返回既有批次
  （响应带 `"replayed": true`，HTTP 200）。

### 标签状态机

| 当前状态 | 重印 | 作废 | 换签 |
| --- | --- | --- | --- |
| ACTIVE | → 旧 SUPERSEDED + 新 ACTIVE | → VOID（无新标签） | → 旧 SUPERSEDED(RETAG) + 新 ACTIVE |
| SUPERSEDED | 409 LABEL_NOT_ACTIVE | 409 LABEL_SUPERSEDED | 409 LABEL_NOT_ACTIVE |
| VOID | 409 LABEL_NOT_ACTIVE | 幂等回显（replayed=true） | 409 LABEL_NOT_ACTIVE |

## 短码规则

- 8 位 Crockford base32：7 位随机负载 + 1 位加权校验位，字符集剔除 I/L/O/U。
- 扫码时自动归一化：去除空白与连字符、转大写、`I/i/L/l→1`、`O/o→0`，再校验长度与校验位。
- 校验不通过返回 `BAD_CODE`（不落库，要求重扫）；校验通过但查无此码返回 `NOT_FOUND`（落库）。

## 幂等与离线补传

两层去重，均可安全重放：

1. **写操作幂等**：重印/作废/换签/登记可带 `Idempotency-Key` 头（1-100 字符）。
   同键重放返回首次响应且带 `"replayed": true`，绝不重复签发标签。
   批次登记即使不带幂等键，也由 `bizKey` 唯一约束保证重复识别不建批。
2. **扫码事件幂等**：每条事件优先使用设备端稳定 `eventId`；未提供时由
   `(deviceId, 归一化短码, scannedAt, station, 经纬度)` 派生 SHA-256 指纹。
   重放返回首次入库结果，不产生重复事件、不创建批次。

定位排序按**设备扫码时间** `scannedAt`（UTC 归一化），因此离线乱序补传后定位仍然正确。
扫旧码得到的 `REDIRECTED` 事件同样代表该批次出现于该位置，纳入定位计算。

## API

错误响应统一信封：`{ "error": { "code", "message", "fieldErrors", "requestId" } }`。

### POST /v1/batches — 批次登记（首次签发标签）

```bash
curl -X POST localhost:3100/v1/batches -H 'content-type: application/json' -d '{
  "bizKey": "WOOL-2026-0921-01",
  "sku": "WOOL-MERINO",
  "name": "美利奴羊毛",
  "quantity": 25.5,
  "unit": "kg",
  "attributes": { "color": "natural" },
  "memo": "可选"
}'
```

201 返回 `{ batch, activeLabel, previousLabel? , replayed? }`；同 bizKey 重复登记为 200 + `replayed: true`。

### POST /v1/labels/:code/reprint — 重印（补打）

请求体 `{ "memo"?: string, "reason"?: "REPRINT" }`（reason 须 `^[A-Z][A-Z0-9_]{0,31}$`）。
旧标签 → SUPERSEDED(reason=REPRINT)，签发新 ACTIVE 标签，旧码扫码 REDIRECTED 到新码。

### POST /v1/labels/:code/void — 作废

请求体 `{ "reason"?: "MANUAL_VOID", "memo"?: string }`（不得使用保留码 REPRINT/RETAG）。
标签 → VOID，批次暂无有效标签；重复作废幂等。

### POST /v1/labels/:code/retag — 换签（物理标签/容器更换）

请求体 `{ "memo"?: string }`。旧标签 → SUPERSEDED(reason=RETAG)，签发新 ACTIVE 标签，旧码重定向。

### GET /v1/labels/:code/resolve — 解析短码（不写事件）

| scanResult | 含义 |
| --- | --- |
| OK | 当前 ACTIVE 标签，返回 batch / activeLabel / chain |
| REDIRECTED | 旧码，沿 replaced_by 链解析到当前 ACTIVE，chain 含完整代际 |
| VOIDED | 链终点已作废（无后继） |
| NOT_FOUND | 校验合法但系统无此码 |
| BAD_CODE | 长度/字符/校验位不合法 |

### POST /v1/scans — 扫码事件上报（支持离线批量补传）

```bash
curl -X POST localhost:3100/v1/scans -H 'content-type: application/json' -d '{
  "events": [
    {
      "eventId": "设备端稳定 UUID（可选，建议必填）",
      "deviceId": "PDA-7",
      "rawCode": "KSBS-XNX4",
      "scannedAt": "2026-09-21T01:05:00Z",
      "station": "原料库 A 区",
      "latitude": 31.23,
      "longitude": 121.47
    }
  ]
}'
```

- 每批 1-500 条；始终返回 200，逐条给出 `accepted/rejected`、`replayed` 与错误码，
  被拒事件可由终端保留后重试，不影响同批其他事件。
- `scannedAt` 接受 ISO8601（`Z` 或 `+08:00` 偏移），服务端统一归一化到 UTC。

### 查询

- `GET /v1/batches/:id` — 批次聚合（全部标签代际、activeLabel、latestLocation）
- `GET /v1/batches/:id/location` — 当前定位（按 scannedAt 最新的 OK/REDIRECTED 事件）
- `GET /v1/batches/:id/history?limit=50` — 扫码轨迹（1-200，默认 50）
- `GET /health/live`、`GET /health/ready`

## 本地运行

```bash
pnpm --filter @handcraft/labels install
pnpm --filter @handcraft/labels db:migrate   # 可选：启动时也会自动迁移
pnpm --filter @handcraft/labels dev          # http://127.0.0.1:3100
pnpm --filter @handcraft/labels test         # Vitest（内存 SQLite）
pnpm --filter @handcraft/labels build
```

配置见 `.env.example`（`PORT`、`DB_PATH`、`LOG_LEVEL` 等）。

## 存储与扩展说明

- 当前使用嵌入式 SQLite（WAL 模式、`BEGIN IMMEDIATE` 串行化写事务、busy_timeout），
  无需外部依赖即可单机运行；所有 SQL 均为标准语法。
- 迁移到 PostgreSQL 时：`INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`/`GENERATED`，
  部分唯一索引语法相同（PostgreSQL 原生支持 `WHERE` 部分索引），
  `INSERT ... ON CONFLICT DO NOTHING RETURNING` 可替代"先查重后插入"的竞态分支；
  事务包装从同步 better-sqlite3 改为 pg 的异步事务即可，领域逻辑无需变更。
- 短码空间 32^7，签发时库内去重 + 重试；如未来需要多实例分配，可把短码改为
  "实例位 + 随机负载"或由独立发码段服务提供。
