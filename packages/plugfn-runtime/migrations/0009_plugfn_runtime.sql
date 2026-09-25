CREATE SCHEMA IF NOT EXISTS omr_plugfn;

REVOKE ALL ON SCHEMA omr_plugfn FROM PUBLIC;

CREATE TABLE IF NOT EXISTS omr_plugfn.records (
  namespace text NOT NULL,
  model text NOT NULL,
  record_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (namespace, model, record_id)
);

CREATE INDEX IF NOT EXISTS plugfn_records_lookup_idx
  ON omr_plugfn.records USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS omr_plugfn.schema_versions (
  namespace text PRIMARY KEY,
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS omr_plugfn.internal_records (
  table_name text NOT NULL,
  record_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (table_name, record_id)
);

CREATE INDEX IF NOT EXISTS plugfn_internal_records_lookup_idx
  ON omr_plugfn.internal_records USING gin (data jsonb_path_ops);
