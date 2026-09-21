-- 批次标签与扫码定位服务：初始结构
-- 设计要点：
--   1. 一个批次在任意时刻至多有一张 ACTIVE 标签（部分唯一索引强约束）。
--   2. 重印 / 换签都保留旧标签，通过 replaced_by 形成标签链，旧码扫码可重定向。
--   3. 作废不签发新标签，批次进入无有效标签状态。
--   4. scan_events 以事件幂等键为主键，离线补传重放不会产生重复事件。
--   5. operation_ledger 记录所有写操作的请求快照与响应，支持任意写接口的重放去重。

CREATE TABLE IF NOT EXISTS batches (
    id              TEXT PRIMARY KEY,            -- B + 时间随机性
    biz_key         TEXT NOT NULL UNIQUE,        -- 上游/识别侧稳定业务键，重复识别不再建批
    sku             TEXT NOT NULL,
    name            TEXT,
    quantity        REAL,
    unit            TEXT,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,               -- ISO8601 UTC
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        TEXT NOT NULL REFERENCES batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    seq             INTEGER NOT NULL,            -- 批次内第几枚标签（从 1 开始）
    short_code      TEXT NOT NULL UNIQUE,        -- Crockford base32，含 1 位校验位
    status          TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'VOID')),
    replace_reason  TEXT,                        -- MANUAL_VOID / REPRINT / RETAG / 自定义原因
    replaced_by_id  INTEGER REFERENCES labels(id),
    memo            TEXT,
    created_at      TEXT NOT NULL,
    replaced_at     TEXT
);

-- 核心不变量：每个批次至多一张 ACTIVE 标签
CREATE UNIQUE INDEX IF NOT EXISTS ux_labels_one_active
    ON labels(batch_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ix_labels_batch ON labels(batch_id);
CREATE INDEX IF NOT EXISTS ix_labels_replaced_by ON labels(replaced_by_id);

CREATE TABLE IF NOT EXISTS scan_events (
    event_id        TEXT PRIMARY KEY,            -- 设备端事件 UUID；缺省时由字段指纹派生
    device_id       TEXT NOT NULL,
    short_code      TEXT NOT NULL,               -- 归一化后扫码内容
    scanned_at      TEXT NOT NULL,               -- 设备扫码时间（离线场景早于入库时间）
    received_at     TEXT NOT NULL,               -- 服务端接收时间
    station         TEXT,
    latitude        REAL,
    longitude       REAL,
    resolved_label_id  INTEGER REFERENCES labels(id),
    resolved_batch_id  TEXT REFERENCES batches(id),
    scan_result     TEXT NOT NULL CHECK (scan_result IN
                        ('OK', 'REDIRECTED', 'VOIDED', 'NOT_FOUND', 'BAD_CODE')),
    detail_json     TEXT NOT NULL DEFAULT '{}'   -- 重放时原样回放的解析结果
);

CREATE INDEX IF NOT EXISTS ix_scan_batch_time ON scan_events(resolved_batch_id, scanned_at);
CREATE INDEX IF NOT EXISTS ix_scan_code_time ON scan_events(short_code, scanned_at);

-- 写操作幂等账本：同一 op_id 的重放返回首次执行结果，绝不重复执行
CREATE TABLE IF NOT EXISTS operation_ledger (
    op_id        TEXT PRIMARY KEY,
    op_type      TEXT NOT NULL,                  -- REGISTER / REPRINT / VOID / RETAG
    request_json TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    response_json TEXT,
    error_code    TEXT,
    created_at    TEXT NOT NULL,
    completed_at  TEXT
);
