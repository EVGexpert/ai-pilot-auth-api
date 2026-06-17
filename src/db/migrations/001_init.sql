-- ============================================================
-- 001_init.sql — PostgreSQL schema for AI Pilot Auth API
-- Compatible with SQLite data format (TEXT timestamps, TEXT IDs)
-- ============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'client',
  email_verified INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sites
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT,
  api_token TEXT,
  wp_version TEXT,
  verified INTEGER DEFAULT 0,
  cached_structure TEXT,
  cached_soul TEXT,
  cached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Email verifications
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_id TEXT,
  title TEXT,
  summary TEXT DEFAULT '',
  summary_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  metadata TEXT,
  source TEXT DEFAULT 'gateway',
  status TEXT DEFAULT 'sent',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);

-- Jobs
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  site_id TEXT,
  user_id TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Audit events
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  site_id TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  status TEXT,
  created_at TEXT NOT NULL
);

-- Config
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Site memory
CREATE TABLE IF NOT EXISTS site_memory (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT DEFAULT 'agent',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id),
  UNIQUE(site_id, key)
);

-- Action requests
CREATE TABLE IF NOT EXISTS action_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  site_id TEXT,
  session_id TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  action_type TEXT NOT NULL,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_url ON sites(url);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, site_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_events(site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_memory_site ON site_memory(site_id);
CREATE INDEX IF NOT EXISTS idx_action_key ON action_requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_action_session ON action_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_site_status ON action_requests(site_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
