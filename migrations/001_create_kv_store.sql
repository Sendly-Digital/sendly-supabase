-- Create table for KV store
-- This table is used to store Twitter card data and other application data

CREATE TABLE IF NOT EXISTS kv_store_7b6d22fe (
  key TEXT NOT NULL PRIMARY KEY,
  value JSONB NOT NULL
);

-- Create index for prefix search optimization
CREATE INDEX IF NOT EXISTS idx_kv_store_key_prefix ON kv_store_7b6d22fe USING btree (key text_pattern_ops);

-- Documentation comments
COMMENT ON TABLE kv_store_7b6d22fe IS 'Key-value store for Twitter cards and other application data';
COMMENT ON COLUMN kv_store_7b6d22fe.key IS 'Unique record key';
COMMENT ON COLUMN kv_store_7b6d22fe.value IS 'JSON record data';







