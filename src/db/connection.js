import initSqlJs from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DB_PATH = config.DATABASE_PATH
export { DB_PATH }
const JSON_PATH = DB_PATH.replace(/\.db$/, '.json')

const dir = path.dirname(DB_PATH)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

// ============================================================
let db
const SQL = await initSqlJs({
  locateFile: file => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file)
})

function openDb() {
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  return db
}

openDb()

// ============================================================
// HELPERS
// ============================================================
// Санитизация: sql.js не принимает undefined
function sanitize(params) {
  return (params || []).map(p => p === undefined ? null : p)
}

export function queryOne(sql, params = []) {
  const stmt = db.prepare(sql)
  const safe = sanitize(params)
  if (safe.length > 0) stmt.bind(safe)
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  return row || null
}

export function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  const safe = sanitize(params)
  if (safe.length > 0) stmt.bind(safe)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

export function run(sql, params = []) {
  db.run(sql, sanitize(params))
  scheduleSave()
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ============================================================
// SAVE — атомарная запись через .tmp + rename
// ============================================================
const TMP_PATH = DB_PATH + '.tmp'
let dirty = false        // были изменения после последнего save?
let closed = false       // БД уже закрыта?

function save() {
  if (closed) return
  try {
    const data = db.export()
    // Атомарная запись: сначала в .tmp, затем rename
    writeFileSync(TMP_PATH, Buffer.from(data))
    renameSync(TMP_PATH, DB_PATH)
    dirty = false
    const size = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0
    console.log(`[DB] Saved: ${DB_PATH} (${size} bytes)`)
  } catch (e) {
    console.error('[DB] Save error:', e.message)
  }
}

let saveTimer = null
function scheduleSave() {
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    save()
    saveTimer = null
  }, 1000)
}

// Фоновый save каждые 10 секунд, если есть изменения
setInterval(() => {
  if (dirty) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    save()
  }
}, 10000)

// ============================================================
// SCHEMA
// ============================================================
db.run(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT, role TEXT DEFAULT 'client', email_verified INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`)
db.run(`CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, name TEXT,
  api_token TEXT, wp_version TEXT, verified INTEGER DEFAULT 0,
  cached_structure TEXT, cached_soul TEXT, cached_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`)
db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`)
db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT, title TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
)`)
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL, metadata TEXT, source TEXT DEFAULT 'gateway',
  created_at TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
)`)
db.run('CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_sites_url ON sites(url)')
db.run('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, site_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)')
db.run('CREATE INDEX IF NOT EXISTS idx_verifications_user ON email_verifications(user_id)')

// ============================================================
// MIGRATIONS
// ============================================================
db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)')
const currentVersion = db.exec('SELECT MAX(version) FROM schema_version')
const ver = currentVersion.length > 0 && currentVersion[0].values[0][0] ? currentVersion[0].values[0][0] : 0

if (ver < 1) {
  try {
    db.run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'")
  } catch (e) { /* already exists */ }
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)', [now()])
}
if (ver < 2) {
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, site_id TEXT, user_id TEXT, session_id TEXT,
    payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
    run_after TEXT, locked_at TEXT, locked_by TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (2, ?)', [now()])
}
if (ver < 3) {
  db.run(`CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, session_id TEXT,
    event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
    payload_json TEXT, ip_address TEXT, user_agent TEXT, request_id TEXT, status TEXT,
    created_at TEXT NOT NULL
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_events(site_id, created_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (3, ?)', [now()])
}

const ver4 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver4 < 4) {
  db.run(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`)
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (4, ?)', [now()])
}
const ver5 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver5 < 5) {
  try {
    db.run("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''")
    db.run("ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT")
  } catch (e) {}
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [now()])
}
const ver6 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver6 < 6) {
  try {
    db.run("ALTER TABLE sites ADD COLUMN cached_structure TEXT")
    db.run("ALTER TABLE sites ADD COLUMN cached_soul TEXT")
    db.run("ALTER TABLE sites ADD COLUMN cached_at TEXT")
    db.run("ALTER TABLE sites ADD COLUMN verified INTEGER DEFAULT 0")
  } catch (e) {}
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (6, ?)', [now()])
}
const ver7 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver7 < 7) {
  db.run(`CREATE TABLE IF NOT EXISTS site_memory (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, source TEXT DEFAULT 'agent', updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id), UNIQUE(site_id, key)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_site_memory_site ON site_memory(site_id)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (7, ?)', [now()])
}
const ver8 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver8 < 8) {
  db.run(`CREATE TABLE IF NOT EXISTS action_requests (
    id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, session_id TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    action_type TEXT NOT NULL, action_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_action_key ON action_requests(idempotency_key)')
  db.run('CREATE INDEX IF NOT EXISTS idx_action_session ON action_requests(session_id)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (8, ?)', [now()])
}

const ver9 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver9 < 9) {
  db.run(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash)')
  db.run('CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (9, ?)', [now()])
}

// ============================================================
// JSON MIGRATION (legacy)
// ============================================================
// Восстановление из .migrated файла, если БД пуста
function recoverFromMigrated() {
  const migratedPath = JSON_PATH + '.migrated'
  if (!existsSync(migratedPath)) return false
  console.log('[DB] Attempting recovery from migrated JSON...')
  let jsonData
  try { jsonData = JSON.parse(readFileSync(migratedPath, 'utf-8')) }
  catch (e) { console.warn('[DB] Failed to parse migrated JSON:', e.message); return false }
  return jsonData
}

function migrateFromJson() {
  if (!existsSync(JSON_PATH)) return false
  const count = db.exec('SELECT COUNT(*) as c FROM users')
  if (count.length > 0 && count[0].values[0][0] > 0) return false
  console.log('[DB] Migrating from JSON to SQLite...')
  let jsonData
  try { jsonData = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) }
  catch (e) { console.warn('[DB] Failed to parse JSON:', e.message); return false }
  try {
    for (const u of (jsonData.users || []))
      db.run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
    for (const s of (jsonData.sites || []))
      db.run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
         typeof s.cached_structure === 'object' ? JSON.stringify(s.cached_structure) : (s.cached_structure || null),
         typeof s.cached_soul === 'object' ? JSON.stringify(s.cached_soul) : (s.cached_soul || null),
         s.cached_at || null, s.created_at, s.updated_at])
    for (const v of (jsonData.emailVerifications || []))
      db.run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?,?,?,?,?)',
        [v.id, v.user_id, v.code, v.expires_at, v.created_at])
    for (const s of (jsonData.chatSessions || []))
      db.run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        [s.id, s.user_id, s.site_id || null, s.title || null, s.created_at, s.updated_at])
    save()
    renameSync(JSON_PATH, JSON_PATH + '.migrated')
    console.log('[DB] Migration complete')
  } catch (e) { console.error('[DB] Migration failed:', e.message) }
}
migrateFromJson()

// Startup guard: если БД пуста после миграций — предупреждение в лог
const startupCheck = db.exec('SELECT COUNT(*) as c FROM users')
const userCount = startupCheck.length > 0 && startupCheck[0].values[0][0] ? startupCheck[0].values[0][0] : 0
if (userCount === 0) {
  console.warn('[DB] ⚠️  База данных пуста — нет пользователей. Пытаюсь восстановить из migrated...')
  const recovered = recoverFromMigrated()
  if (recovered && Array.isArray(recovered.users) && recovered.users.length > 0) {
    for (const u of recovered.users)
      db.run('INSERT OR IGNORE INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
    for (const s of (recovered.sites || []))
      db.run('INSERT OR IGNORE INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
         null, null, null, s.created_at, s.updated_at])
    save()
    const restored = db.exec('SELECT COUNT(*) as c FROM users')
    const restoredCount = restored.length > 0 && restored[0].values[0][0] ? restored[0].values[0][0] : 0
    console.log(`[DB] ✅ Восстановлено ${restoredCount} пользователей из .migrated`)
  } else {
    console.warn('[DB] ⚠️  .migrated не найден или пуст. Убедитесь, что volume подключён.')
  }
} else {
  console.log(`[DB] ✅ БД загружена: ${userCount} пользователей`)
}

// ============================================================
// SHUTDOWN — синхронный save при завершении
// ============================================================
export function close() {
  if (closed) return  // idempotent
  closed = true
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (dirty) {
    save()
  }
  try { db.close() } catch (e) { /* уже закрыта */ }
  const size = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0
  console.log(`[DB] Closed: ${DB_PATH} (${size} bytes)`)
}

process.on('SIGINT', () => { close(); process.exit(0) })
process.on('SIGTERM', () => { close(); process.exit(0) })
process.on('beforeExit', () => {
  if (dirty && !closed) {
    try { save() } catch (e) { /* log already in save */ }
  }
})

export default db
