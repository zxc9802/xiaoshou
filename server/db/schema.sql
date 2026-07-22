CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_label text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_jobs_org_created_idx ON analysis_jobs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_jobs_expiry_idx ON analysis_jobs (expires_at);

CREATE TABLE IF NOT EXISTS conversation_reviews (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','confirmed','archived')),
  outcome text NOT NULL CHECK (outcome IN ('progressed','unchanged','regressed','won','lost','unknown')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_reviews_org_updated_idx ON conversation_reviews (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS analysis_feedback (
  id uuid PRIMARY KEY,
  analysis_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('adopted','rejected','edited_adopted','saved_review')),
  reason text,
  edited_reply text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id uuid PRIMARY KEY,
  organization_id text,
  layer text NOT NULL CHECK (layer IN ('L0','L1','L2','L3','L4')),
  category text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','in_review','published','archived')),
  version text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_entries_retrieval_idx ON knowledge_entries (organization_id, layer, status, category);

CREATE TABLE IF NOT EXISTS product_profiles (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','published','archived')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_profiles_org_name_idx ON product_profiles (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS knowledge_import_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('importing','extracting','analyzing','grouping','waiting_review','published','failed')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_label text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_import_jobs_org_created_idx ON knowledge_import_jobs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_index_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  entry_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert','delete')),
  status text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_index_jobs_claim_idx
  ON knowledge_index_jobs (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS knowledge_index_jobs_entry_idx
  ON knowledge_index_jobs (organization_id, entry_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (organization_id, target_type, target_id, created_at DESC);
