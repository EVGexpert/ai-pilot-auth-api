import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'aipilot.db')
const JSON_PATH = DB_PATH.replace(/\.db$/, '.json')

const dir = path.dirname(DB_PATH)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

// ============================================================
// Open database (node:sqlite — writes directly to disk, no manual save)
// ============================================================
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// ============================================================
// HELPERS
// ============================================================
function sanitize(params) {
  return (params || []).map(p => p === undefined ? null : p)
}

export function queryOne(sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    return stmt.get(...sanitize(params)) || null
  } finally {
    stmt.free()
  }
}

export function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    return stmt.all(...sanitize(params))
  } finally {
    stmt.free()
  }
}

export function run(sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    return stmt.run(...sanitize(params))
  } finally {
    stmt.free()
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ============================================================
// SCHEMA
// ============================================================
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT, role TEXT DEFAULT 'client', email_verified INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`)
db.exec(`CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, name TEXT,
  api_token TEXT, wp_version TEXT, verified INTEGER DEFAULT 0,
  cached_structure TEXT, cached_soul TEXT, cached_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`)
db.exec(`CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`)
db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT, title TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
)`)
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL, metadata TEXT, source TEXT DEFAULT 'gateway',
  created_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
)`)
db.exec('CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_sites_url ON sites(url)')
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, site_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_verifications_user ON email_verifications(user_id)')

// ============================================================
// MIGRATIONS
// ============================================================
const verRow = queryOne('SELECT MAX(version) as v FROM schema_version')
let ver = verRow?.v || 0

if (ver < 1) {
  try { run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'") } catch (e) { /* already exists */ }
  run('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)', [now()])
  ver = 1
}
if (ver < 2) {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, site_id TEXT, user_id TEXT, session_id TEXT,
    payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    run_after TEXT, locked_at TEXT, locked_by TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after)')
  run('INSERT INTO schema_version (version, applied_at) VALUES (2, ?)', [now()])
  ver = 2
}
if (ver < 3) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, session_id TEXT,
    event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
    payload_json TEXT, ip_address TEXT, user_agent TEXT, request_id TEXT, status TEXT,
    created_at TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_events(site_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at)')
  run('INSERT INTO schema_version (version, applied_at) VALUES (3, ?)', [now()])
  ver = 3
}

if (ver < 4) {
  db.exec(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`)
  run('INSERT INTO schema_version (version, applied_at) VALUES (4, ?)', [now()])
  ver = 4
}
if (ver < 5) {
  try { run("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''") } catch (e) {}
  try { run("ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT") } catch (e) {}
  run('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [now()])
  ver = 5
}
if (ver < 6) {
  try { run("ALTER TABLE sites ADD COLUMN cached_structure TEXT") } catch (e) {}
  try { run("ALTER TABLE sites ADD COLUMN cached_soul TEXT") } catch (e) {}
  try { run("ALTER TABLE sites ADD COLUMN cached_at TEXT") } catch (e) {}
  try { run("ALTER TABLE sites ADD COLUMN verified INTEGER DEFAULT 0") } catch (e) {}
  run('INSERT INTO schema_version (version, applied_at) VALUES (6, ?)', [now()])
  ver = 6
}
if (ver < 7) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_memory (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, source TEXT DEFAULT 'agent', updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id), UNIQUE(site_id, key)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_site_memory_site ON site_memory(site_id)')
  run('INSERT INTO schema_version (version, applied_at) VALUES (7, ?)', [now()])
  ver = 7
}
if (ver < 8) {
  db.exec(`CREATE TABLE IF NOT EXISTS action_requests (
    id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, session_id TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    action_type TEXT NOT NULL, action_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_action_key ON action_requests(idempotency_key)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_action_session ON action_requests(session_id)')
  run('INSERT INTO schema_version (version, applied_at) VALUES (8, ?)', [now()])
  ver = 8
}

// ============================================================
// JSON MIGRATION (legacy)
// ============================================================
function recoverFromMigrated() {
  const migratedPath = JSON_PATH + '.migrated'
  if (!existsSync(migratedPath)) return false
  console.log('[DB] Attempting recovery from migrated JSON...')
  try { return JSON.parse(readFileSync(migratedPath, 'utf-8')) }
  catch (e) { console.warn('[DB] Failed to parse migrated JSON:', e.message); return false }
}

function migrateFromJson() {
  if (!existsSync(JSON_PATH)) return false
  const count = queryOne('SELECT COUNT(*) as c FROM users')
  if (count?.c > 0) return false
  console.log('[DB] Migrating from JSON to SQLite...')
  let jsonData
  try { jsonData = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) }
  catch (e) { console.warn('[DB] Failed to parse JSON:', e.message); return false }
  try {
    for (const u of (jsonData.users || []))
      run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
    for (const s of (jsonData.sites || []))
      run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
         typeof s.cached_structure === 'object' ? JSON.stringify(s.cached_structure) : (s.cached_structure || null),
         typeof s.cached_soul === 'object' ? JSON.stringify(s.cached_soul) : (s.cached_soul || null),
         s.cached_at || null, s.created_at, s.updated_at])
    for (const v of (jsonData.emailVerifications || []))
      run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?,?,?,?,?)',
        [v.id, v.user_id, v.code, v.expires_at, v.created_at])
    for (const s of (jsonData.chatSessions || []))
      run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        [s.id, s.user_id, s.site_id || null, s.title || null, s.created_at, s.updated_at])
    renameSync(JSON_PATH, JSON_PATH + '.migrated')
    console.log('[DB] Migration complete')
  } catch (e) { console.error('[DB] Migration failed:', e.message) }
}
migrateFromJson()

// Startup guard: если БД пуста — попытка восстановить из .migrated
const userCount = queryOne('SELECT COUNT(*) as c FROM users')?.c || 0
if (userCount === 0) {
  console.warn('[DB] ⚠️  База данных пуста — нет пользователей. Пытаюсь восстановить из migrated...')
  const recovered = recoverFromMigrated()
  if (recovered && Array.isArray(recovered.users) && recovered.users.length > 0) {
    for (const u of recovered.users)
      run('INSERT OR IGNORE INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
    for (const s of (recovered.sites || []))
      run('INSERT OR IGNORE INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
         null, null, null, s.created_at, s.updated_at])
    const restored = queryOne('SELECT COUNT(*) as c FROM users')?.c || 0
    console.log(`[DB] ✅ Восстановлено ${restored} пользователей из .migrated`)
  } else {
    console.warn('[DB] ⚠️  .migrated не найден или пуст. Убедитесь, что volume подключён.')
  }
} else {
  console.log(`[DB] ✅ БД загружена: ${userCount} пользователей`)
}

// ============================================================
// SHUTDOWN
// ============================================================
export function close() {
  db.pragma('journal_mode = DELETE')
  db.close()
}
process.on('SIGINT', () => { close(); process.exit(0) })
process.on('SIGTERM', () => { close(); process.exit(0) })

export default db
