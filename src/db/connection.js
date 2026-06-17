import { existsSync, mkdirSync, renameSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============================================================
// MODE DETECTION
// ============================================================
const USE_PG = !!config.DATABASE_URL
export const DB_PATH = config.DATABASE_PATH
export const DB_MODE = USE_PG ? 'postgresql' : 'sqlite'

const JSON_PATH = DB_PATH.replace(/\.db$/, '.json')

// ============================================================
// SHARED HELPERS
// ============================================================
function sanitize(params) {
  return (params || []).map(p => p === undefined ? null : p)
}

/** Convert SQLite ? placeholders to PG $1, $2, ... */
function convertPlaceholders(sql) {
  let idx = 0
  return sql.replace(/\?/g, () => `$${++idx}`)
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// ============================================================
// DATABASE CONNECTION & INTERFACE
// ============================================================
let _queryOne, _queryAll, _run, _exec, _close

if (USE_PG) {
  // ──────────────────────────────────────────────────────────
  // POSTGRESQL MODE
  // ──────────────────────────────────────────────────────────
  const pool = (await import('./pg.js')).default

  _queryOne = async function queryOne(sql, params = []) {
    const { rows } = await pool.query(convertPlaceholders(sql), sanitize(params))
    return rows[0] || null
  }

  _queryAll = async function queryAll(sql, params = []) {
    const { rows } = await pool.query(convertPlaceholders(sql), sanitize(params))
    return rows
  }

  _run = async function run(sql, params = []) {
    const result = await pool.query(convertPlaceholders(sql), sanitize(params))
    return { changes: result.rowCount, lastInsertRowid: null }
  }

  _exec = async function exec(sql) {
    await pool.query(sql)
  }

  _close = async function close() {
    await pool.end()
  }

  // ──── PG SCHEMA INITIALIZATION ────
  console.log('[DB] PostgreSQL mode — initializing schema...')

  const initSql = readFileSync(path.join(__dirname, 'migrations', '001_init.sql'), 'utf-8')
  await pool.query(initSql)
  console.log('[DB] ✅ PostgreSQL schema initialized')

  // ──── PG MIGRATIONS (same version tracking as SQLite) ────
  let verRow = await _queryOne('SELECT MAX(version) as v FROM schema_version')
  let ver = verRow?.v || 0

  if (ver < 1) {
    try { await _run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'") } catch (e) { /* already exists */ }
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)', [now()])
    ver = 1
  }
  if (ver < 5) {
    try { await _run("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''") } catch (e) { /* already exists */ }
    try { await _run('ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT') } catch (e) { /* already exists */ }
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [now()])
    ver = 5
  }
  // Note: migrations 2-4, 6-10 are CREATE TABLE IF NOT EXISTS which are handled by 001_init.sql

  console.log(`[DB] PostgreSQL migrations: v${ver}`)
  console.log('[DB] ✅ PostgreSQL ready')

} else {
  // ──────────────────────────────────────────────────────────
  // SQLITE MODE (node:sqlite — existing logic)
  // ──────────────────────────────────────────────────────────
  const { DatabaseSync } = await import('node:sqlite')

  const dir = path.dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('PRAGMA foreign_keys = ON')

  _queryOne = async function queryOne(sql, params = []) {
    const stmt = db.prepare(sql)
    return stmt.get(...sanitize(params)) || null
  }

  _queryAll = async function queryAll(sql, params = []) {
    const stmt = db.prepare(sql)
    return stmt.all(...sanitize(params))
  }

  _run = async function run(sql, params = []) {
    const stmt = db.prepare(sql)
    return stmt.run(...sanitize(params))
  }

  _exec = async function exec(sql) {
    db.exec(sql)
  }

  _close = async function close() {
    try { db.exec('PRAGMA journal_mode = DELETE') } catch (e) { /* already closing */ }
    db.close()
  }

  // ──── SQLITE SCHEMA INITIALIZATION ────
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

  // ──── SQLITE MIGRATIONS ────
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)')

  const schemaTables = await _queryOne("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'")
  if (!schemaTables?.c || schemaTables.c < 2) {
    console.warn('[DB] ⚠️  Схема не инициализирована: пустая БД.')
  }

  let verRow = await _queryOne('SELECT MAX(version) as v FROM schema_version')
  let ver = verRow?.v || 0

  if (ver < 1) {
    try { await _run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'") } catch (e) { /* already exists */ }
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)', [now()])
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
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (2, ?)', [now()])
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
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (3, ?)', [now()])
    ver = 3
  }
  if (ver < 4) {
    db.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`)
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (4, ?)', [now()])
    ver = 4
  }
  if (ver < 5) {
    try { await _run("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''") } catch (e) { /* already exists */ }
    try { await _run('ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT') } catch (e) { /* already exists */ }
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [now()])
    ver = 5
  }
  if (ver < 6) {
    try { await _run('ALTER TABLE sites ADD COLUMN cached_structure TEXT') } catch (e) { /* already exists */ }
    try { await _run('ALTER TABLE sites ADD COLUMN cached_soul TEXT') } catch (e) { /* already exists */ }
    try { await _run('ALTER TABLE sites ADD COLUMN cached_at TEXT') } catch (e) { /* already exists */ }
    try { await _run('ALTER TABLE sites ADD COLUMN verified INTEGER DEFAULT 0') } catch (e) { /* already exists */ }
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (6, ?)', [now()])
    ver = 6
  }
  if (ver < 7) {
    db.exec(`CREATE TABLE IF NOT EXISTS site_memory (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, source TEXT DEFAULT 'agent', updated_at TEXT NOT NULL,
      FOREIGN KEY (site_id) REFERENCES sites(id), UNIQUE(site_id, key)
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_site_memory_site ON site_memory(site_id)')
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (7, ?)', [now()])
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
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (8, ?)', [now()])
    ver = 8
  }
  if (ver < 9) {
    db.exec(`CREATE TABLE IF NOT EXISTS refresh_tokens (
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id)')
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (9, ?)', [now()])
    ver = 9
  }
  if (ver < 10) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_actions_site_status ON action_requests(site_id, status)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after)')
    await _run('INSERT INTO schema_version (version, applied_at) VALUES (10, ?)', [now()])
    console.log('[DB] Migration v10: indexes added')
    ver = 10
  }

  // ──── JSON MIGRATION (legacy) ────
  function recoverFromMigrated() {
    const migratedPath = JSON_PATH + '.migrated'
    if (!existsSync(migratedPath)) return false
    console.log('[DB] Attempting recovery from migrated JSON...')
    try { return JSON.parse(readFileSync(migratedPath, 'utf-8')) }
    catch (e) { console.warn('[DB] Failed to parse migrated JSON:', e.message); return false }
  }

  async function migrateFromJson() {
    if (!existsSync(JSON_PATH)) return false
    const count = await _queryOne('SELECT COUNT(*) as c FROM users')
    if (count?.c > 0) return false
    console.log('[DB] Migrating from JSON to SQLite...')
    let jsonData
    try { jsonData = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) }
    catch (e) { console.warn('[DB] Failed to parse JSON:', e.message); return false }
    try {
      for (const u of (jsonData.users || []))
        await _run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
      for (const s of (jsonData.sites || []))
        await _run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
           typeof s.cached_structure === 'object' ? JSON.stringify(s.cached_structure) : (s.cached_structure || null),
           typeof s.cached_soul === 'object' ? JSON.stringify(s.cached_soul) : (s.cached_soul || null),
           s.cached_at || null, s.created_at, s.updated_at])
      for (const v of (jsonData.emailVerifications || []))
        await _run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?,?,?,?,?)',
          [v.id, v.user_id, v.code, v.expires_at, v.created_at])
      for (const s of (jsonData.chatSessions || []))
        await _run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          [s.id, s.user_id, s.site_id || null, s.title || null, s.created_at, s.updated_at])
      renameSync(JSON_PATH, JSON_PATH + '.migrated')
      console.log('[DB] Migration complete')
    } catch (e) { console.error('[DB] Migration failed:', e.message) }
  }
  await migrateFromJson()

  // Startup guard
  const userCount = (await _queryOne('SELECT COUNT(*) as c FROM users'))?.c || 0
  if (userCount === 0) {
    console.warn('[DB] ⚠️  База данных пуста — нет пользователей. Пытаюсь восстановить из migrated...')
    const recovered = recoverFromMigrated()
    if (recovered && Array.isArray(recovered.users) && recovered.users.length > 0) {
      for (const u of recovered.users)
        await _run('INSERT OR IGNORE INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
      for (const s of (recovered.sites || []))
        await _run('INSERT OR IGNORE INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0,
           null, null, null, s.created_at, s.updated_at])
      const restored = (await _queryOne('SELECT COUNT(*) as c FROM users'))?.c || 0
      console.log(`[DB] ✅ Восстановлено ${restored} пользователей из .migrated`)
    } else {
      console.warn('[DB] ⚠️  .migrated не найден или пуст. Убедитесь, что volume подключён.')
    }
  } else {
    console.log(`[DB] ✅ БД загружена: ${userCount} пользователей`)
  }

  // ──── SQLITE INTEGRITY CHECKS ────
  const MANDATORY_TABLES = ['users', 'sites', 'chat_sessions', 'messages', 'schema_version']
  for (const table of MANDATORY_TABLES) {
    try {
      const row = await _queryOne(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`)
      if (!row) {
        console.error(`[DB] ❌ Обязательная таблица '${table}' отсутствует!`)
        if (config.NODE_ENV === 'production') {
          console.error('[DB] БД повреждена или неполная. Выход.')
          process.exit(1)
        }
      }
    } catch (e) {
      console.warn(`[DB] ⚠️  Не удалось проверить таблицу '${table}':`, e.message)
    }
  }

  if (userCount > 0) {
    try {
      const msgCount = (await _queryOne('SELECT COUNT(*) as c FROM messages'))?.c || 0
      console.log(`[DB] 📊  Сообщений: ${msgCount}`)
    } catch (e) {
      console.warn('[DB] ⚠️  Не удалось прочитать messages:', e.message)
    }
  }
}

// ============================================================
// PUBLIC EXPORTS
// ============================================================
export const queryOne = _queryOne
export const queryAll = _queryAll
export const run = _run
export const close = _close

/** Check database connectivity (used by health endpoint) */
export async function ping() {
  if (USE_PG) {
    const pool = (await import('./pg.js')).default
    const client = await pool.connect()
    client.release()
    return true
  } else {
    await _queryOne('SELECT 1')
    return true
  }
}

export default { queryOne, queryAll, run, close, uid, now, ping, DB_PATH, DB_MODE }
