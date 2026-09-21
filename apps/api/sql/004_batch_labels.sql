-- 批次标签（短码）、扫码定位与离线补传
-- 设计要点：
--   1. 短码全库唯一且不变；作废/换签只改状态，不回收、不删除，扫码永远能解析出结论。
--   2. 换签形成 predecessor -> successor 链；扫码旧签可沿链定位到当前有效签。
--   3. 每批至多一枚有效签（部分唯一索引），换签在同一事务内完成旧签置 REPLACED 与新签 ACTIVE。
--   4. scan_events / batch_recognitions 以客户端事件 ID 去重，离线补传可整体重放。
--   5. 批次识别以 (material_id, lower(batch_code)) 自然键 find-or-create，
--      重复识别（重试、换设备、补传）绝不产生第二个批次。

CREATE TYPE label_status AS ENUM ('ACTIVE', 'VOIDED', 'REPLACED');
CREATE TYPE label_event_action AS ENUM ('ISSUE', 'REPRINT', 'VOID', 'REPLACE');
CREATE TYPE scan_result AS ENUM ('OK', 'REPLACED', 'VOIDED', 'UNKNOWN');

-- 离线识别可先建档（尚无入库数量），PENDING 批次待正式入库时转为 ACTIVE。
ALTER TYPE batch_status ADD VALUE 'PENDING' BEFORE 'ACTIVE';
ALTER TABLE batches ADD COLUMN recognized_at timestamptz;
-- 初始数量原约束为 > 0；PENDING 识别建档尚无数量，放宽为 >= 0，由状态约束兜底语义。
ALTER TABLE batches DROP CONSTRAINT batches_initial_quantity_check;
ALTER TABLE batches ADD CONSTRAINT batches_initial_quantity_check CHECK (initial_quantity >= 0);
ALTER TABLE batches DROP CONSTRAINT batches_status_quantity_chk;
ALTER TABLE batches ADD CONSTRAINT batches_status_quantity_chk CHECK (
  (status = 'PENDING' AND remaining_quantity = 0)
  OR (status = 'ACTIVE' AND remaining_quantity > 0)
  OR (status = 'DEPLETED' AND remaining_quantity = 0)
  OR (status = 'ARCHIVED' AND remaining_quantity = 0)
);

CREATE TABLE batch_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code char(8) NOT NULL,
  batch_id uuid NOT NULL REFERENCES batches(id),
  status label_status NOT NULL DEFAULT 'ACTIVE',
  print_seq integer NOT NULL DEFAULT 1 CHECK (print_seq >= 1),
  predecessor_id uuid REFERENCES batch_labels(id),
  successor_id uuid REFERENCES batch_labels(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'VOIDED' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  -- ACTIVE 签不允许有作废信息或后继签。
  CHECK (status <> 'ACTIVE' OR (successor_id IS NULL AND voided_at IS NULL)),
  CHECK (status <> 'REPLACED' OR successor_id IS NOT NULL)
);
CREATE UNIQUE INDEX batch_labels_short_code_uq ON batch_labels(short_code);
-- 每批至多一枚 ACTIVE 签。普通部分唯一索引不能 DEFERRABLE，换签采用「先插新签（此时旧签
-- 仍 ACTIVE）、再把旧签置 REPLACED」的顺序，需要可延迟的排他约束，事务提交时收敛为一枚。
ALTER TABLE batch_labels
  ADD CONSTRAINT batch_labels_one_active_excl
  EXCLUDE (batch_id WITH =) WHERE (status = 'ACTIVE')
  DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX batch_labels_batch_idx ON batch_labels(batch_id);
CREATE INDEX batch_labels_predecessor_idx ON batch_labels(predecessor_id);
CREATE INDEX batch_labels_successor_idx ON batch_labels(successor_id);

CREATE TABLE label_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_id uuid NOT NULL REFERENCES batch_labels(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  action label_event_action NOT NULL,
  successor_id uuid REFERENCES batch_labels(id),
  reason varchar(200),
  client_request_id varchar(100),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX label_events_client_request_uq ON label_events(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX label_events_label_idx ON label_events(label_id, created_at);

CREATE TABLE scan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  short_code char(8) NOT NULL,
  label_id uuid REFERENCES batch_labels(id),
  batch_id uuid REFERENCES batches(id),
  -- 解析结论在首次入库时冻结；重放返回同一结论，而不是按当前标签状态重新计算。
  result scan_result NOT NULL,
  effective_label_id uuid REFERENCES batch_labels(id),
  scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  device_id varchar(80) NOT NULL,
  operator varchar(80),
  location_name varchar(120),
  latitude numeric(9,6) CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude numeric(9,6) CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  note varchar(500),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 离线重放去重的核心约束：同一客户端事件 ID 只认首次入库。
CREATE UNIQUE INDEX scan_events_event_id_uq ON scan_events(event_id);
CREATE INDEX scan_events_batch_scanned_idx ON scan_events(batch_id, scanned_at DESC) WHERE batch_id IS NOT NULL;
CREATE INDEX scan_events_label_idx ON scan_events(label_id, scanned_at DESC);
CREATE INDEX scan_events_device_idx ON scan_events(device_id, scanned_at DESC);

-- 识别（OCR/手工录入/离线补传）记录：自然键幂等的批次创建。
CREATE TABLE batch_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES batches(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  batch_code varchar(64) NOT NULL,
  device_id varchar(80) NOT NULL,
  recognized_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX batch_recognitions_event_id_uq ON batch_recognitions(event_id);
CREATE INDEX batch_recognitions_batch_idx ON batch_recognitions(batch_id, recognized_at DESC);

CREATE TRIGGER batch_labels_updated_at BEFORE UPDATE ON batch_labels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
