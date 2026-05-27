import initSqlJs from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'aipilot.db')
const JSON_PATH = DB_PATH.replace(/\.db$/, '.json')

// Создаём папку если нет
const dir = path.dirname(DB_PATH)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

// ============================================================
// INIT SQLite
// ============================================================
let db
const SQL = await initSqlJs({
  locateFile: file => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
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
// SCHEMA
// ============================================================
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'client',
    email_verified INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`)
db.run(`
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
  )
`)
db.run(`
  CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.run(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    site_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  )
`)
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    metadata TEXT,
    source TEXT DEFAULT 'gateway',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
  )
`)
db.run('CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_sites_url ON sites(url)')
db.run('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, site_id)')
db.run('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)')
db.run('CREATE INDEX IF NOT EXISTS idx_verifications_user ON email_verifications(user_id)')

// ============================================================
// SCHEMA VERSIONING & MIGRATIONS
// ============================================================
db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)')
const currentVersion = db.exec('SELECT MAX(version) FROM schema_version')
const ver = currentVersion.length > 0 && currentVersion[0].values[0][0] ? currentVersion[0].values[0][0] : 0

// Migration 1: add status to messages
if (ver < 1) {
  try {
    db.run("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'")
    db.run("ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'gateway'")
  } catch (e) { /* columns may already exist */ }
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)', [now()])
}

// Migration 2: add jobs table
if (ver < 2) {
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
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
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (2, ?)', [now()])
}

// Migration 3: add audit_events table
if (ver < 3) {
  db.run(`CREATE TABLE IF NOT EXISTS audit_events (
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
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_events(site_id, created_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (3, ?)', [now()])
}

// Schema v4: config key-value
const ver4 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver4 < 4) {
  db.run(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`)
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (4, ?)', [now()])
}

// Schema v5: session summary
const ver5 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver5 < 5) {
  try {
    db.run("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''")
    db.run("ALTER TABLE chat_sessions ADD COLUMN summary_updated_at TEXT")
  } catch (e) { /* колонки уже могут существовать */ }
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)', [now()])
}

// Schema v6: add missing columns to sites
const ver6 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver6 < 6) {
  try {
    db.run("ALTER TABLE sites ADD COLUMN cached_structure TEXT")
    db.run("ALTER TABLE sites ADD COLUMN cached_soul TEXT")
    db.run("ALTER TABLE sites ADD COLUMN cached_at TEXT")
    db.run("ALTER TABLE sites ADD COLUMN verified INTEGER DEFAULT 0")
  } catch (e) { /* колонки уже могут существовать */ }
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (6, ?)', [now()])
}

// Schema v7: site_memory — долгосрочная память по сайтам
const ver7 = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
if (ver7 < 7) {
  db.run(`CREATE TABLE IF NOT EXISTS site_memory (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT DEFAULT 'agent',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id),
    UNIQUE(site_id, key)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_site_memory_site ON site_memory(site_id)')
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (7, ?)', [now()])
}

/**
 * Получить значение конфига по ключу.
 */
export function getConfigValue(key) {
  const row = queryOne('SELECT value FROM config WHERE key = ?', [key])
  return row?.value || null
}

/**
 * Установить значение конфига.
 */
export function setConfigValue(key, value) {
  db.run(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value])
  save()
}

// ============================================================
// AUTO-SAVE to disk
// ============================================================
function save() {
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(DB_PATH, buffer)
  } catch (e) {
    console.error('[DB] Save error:', e.message)
  }
}

// Сохраняем через 1s после последнего изменения (debounce)
let saveTimer = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    save()
    saveTimer = null
  }, 1000)
}



// ============================================================
// MIGRATION из JSON в SQLite
// ============================================================
function migrateFromJson() {
  if (!existsSync(JSON_PATH)) return false

  // Проверяем, есть ли уже данные
  const count = db.exec('SELECT COUNT(*) as c FROM users')
  if (count.length > 0 && count[0].values[0][0] > 0) return false

  console.log('[DB] Migrating from JSON to SQLite...')

  let jsonData
  try {
    jsonData = JSON.parse(readFileSync(JSON_PATH, 'utf-8'))
  } catch (e) {
    console.warn('[DB] Failed to parse JSON file, skipping migration:', e.message)
    return false
  }

  try {
    for (const u of (jsonData.users || [])) {
      db.run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [u.id, u.email, u.password_hash, u.name || null, u.role || 'client', u.email_verified || 0, u.created_at, u.updated_at])
    }
    for (const s of (jsonData.sites || [])) {
      const cachedStruct = typeof s.cached_structure === 'object' ? JSON.stringify(s.cached_structure) : (s.cached_structure || null)
      const cachedSoul = typeof s.cached_soul === 'object' ? JSON.stringify(s.cached_soul) : (s.cached_soul || null)
      db.run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [s.id, s.user_id, s.url, s.name || null, s.api_token || null, s.wp_version || null, s.verified || 0, cachedStruct, cachedSoul, s.cached_at || null, s.created_at, s.updated_at])
    }
    for (const v of (jsonData.emailVerifications || [])) {
      db.run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        [v.id, v.user_id, v.code, v.expires_at, v.created_at])
    }
    for (const s of (jsonData.chatSessions || [])) {
      db.run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [s.id, s.user_id, s.site_id || null, s.title || null, s.created_at, s.updated_at])
    }
    save()
    renameSync(JSON_PATH, JSON_PATH + '.migrated')
    console.log('[DB] Migration complete. JSON renamed to', JSON_PATH + '.migrated')
  } catch (e) {
    console.error('[DB] Migration failed:', e.message)
  }
  return true
}

migrateFromJson()

// ============================================================
// HELPERS — sql.js wrapper
// ============================================================

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// Санитизация параметров — заменяет undefined на null (sql.js не принимает undefined)
function sanitize(params) {
  return (params || []).map(p => p === undefined ? null : p)
}

// Вспомогательные функции для работы с sql.js
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql)
  const safe = sanitize(params)
  if (safe.length > 0) stmt.bind(safe)
  let row = null
  if (stmt.step()) row = stmt.getAsObject()
  stmt.free()
  return row || null
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  const safe = sanitize(params)
  if (safe.length > 0) stmt.bind(safe)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function run(sql, params = []) {
  const safe = sanitize(params)
  db.run(sql, safe)
  scheduleSave()
}

// --- Users ---
export function findUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = ?', [email])
}
export function findUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = ?', [id])
}
export function createUser({ email, passwordHash, name, role = 'client' }) {
  const id = uid()
  const t = now()
  run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [id, email, passwordHash, name || null, role, t, t])
  return findUserById(id)
}
export function updateUser(id, fields) {
  const sets = []
  const params = []
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name) }
  if (fields.email_verified !== undefined) { sets.push('email_verified = ?'); params.push(fields.email_verified) }
  if (sets.length === 0) return findUserById(id)
  params.push(now(), id)
  run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params)
  return findUserById(id)
}

// --- Sites ---
export function findSitesByUser(userId) {
  return queryAll('SELECT * FROM sites WHERE user_id = ?', [userId])
}
export function findSiteByUserAndUrl(userId, url) {
  return queryOne('SELECT * FROM sites WHERE user_id = ? AND url = ?', [userId, url])
}
export function findSiteById(id) {
  return queryOne('SELECT * FROM sites WHERE id = ?', [id])
}
export function createSite({ userId, url, name, apiToken, wpVersion, verified = 0 }) {
  const id = uid()
  const t = now()
  run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, url, name || null, apiToken || null, wpVersion || null, verified, t, t])
  return findSiteById(id)
}
export function updateSiteCache(id, fields) {
  const struct = fields.cached_structure ? (typeof fields.cached_structure === 'string' ? fields.cached_structure : JSON.stringify(fields.cached_structure)) : null
  const soul = fields.cached_soul ? (typeof fields.cached_soul === 'string' ? fields.cached_soul : JSON.stringify(fields.cached_soul)) : null
  run('UPDATE sites SET cached_structure = COALESCE(?, cached_structure), cached_soul = COALESCE(?, cached_soul), cached_at = COALESCE(?, cached_at), updated_at = ? WHERE id = ?',
    [struct, soul, fields.cached_at || null, now(), id])
  return findSiteById(id)
}
export function updateSiteToken(id, token) {
  run('UPDATE sites SET api_token = ?, verified = 1, updated_at = ? WHERE id = ?', [token, now(), id])
  return findSiteById(id)
}
export function deleteSite(id) {
  run('DELETE FROM sites WHERE id = ?', [id])
  return true
}
export function allSites() {
  return queryAll('SELECT * FROM sites ORDER BY created_at DESC')
}

// --- Site memory ---

/**
 * Получить всю память сайта.
 */
export function getSiteMemory(siteId) {
  return queryAll('SELECT key, value, source, updated_at FROM site_memory WHERE site_id = ? ORDER BY updated_at DESC', [siteId])
}

/**
 * Получить конкретную запись памяти по ключу.
 */
export function getSiteMemoryByKey(siteId, key) {
  return queryOne('SELECT value, source, updated_at FROM site_memory WHERE site_id = ? AND key = ?', [siteId, key])
}

/**
 * Установить/обновить запись в памяти сайта.
 */
export function setSiteMemory(siteId, key, value, source = 'agent') {
  const t = now()
  db.run(`INSERT INTO site_memory (id, site_id, key, value, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
    [uid(), siteId, key, value, source, t])
  return { site_id: siteId, key, value, source, updated_at: t }
}

/**
 * Удалить запись из памяти сайта.
 */
export function deleteSiteMemory(siteId, key) {
  run('DELETE FROM site_memory WHERE site_id = ? AND key = ?', [siteId, key])
}

/**
 * Собрать память сайта в компактный текст для промпта.
 * Возвращает строку вроде "Предпочтения: ... | Запрещённые формулировки: ..."
 */
export function formatSiteMemory(siteId) {
  const mems = getSiteMemory(siteId)
  if (mems.length === 0) return ''
  return mems.map(m => `${m.key}: ${m.value.slice(0, 200)}`).join(' | ')
}

// --- Email verifications ---
export function createVerification(userId, code) {
  const id = uid()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, code, expiresAt, now()])
  return { id, user_id: userId, code, expires_at: expiresAt, created_at: now() }
}
export function findVerification(userId, code) {
  return queryOne('SELECT * FROM email_verifications WHERE user_id = ? AND code = ? AND expires_at > ?', [userId, code, now()])
}
export function deleteVerificationsByUser(userId) {
  run('DELETE FROM email_verifications WHERE user_id = ?', [userId])
}

// --- Chat sessions ---
export function updateSessionSummary(sessionId) {
  const msgs = queryAll('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
  if (msgs.length < 12) return false
  const oldMsgs = msgs.slice(0, msgs.length - 12).filter(m => m.role !== 'system')
  if (oldMsgs.length < 3) return false
  const summary = oldMsgs.map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join(' | ').slice(0, 2000)
  run('UPDATE chat_sessions SET summary = ?, summary_updated_at = ? WHERE id = ?', [summary, new Date().toISOString(), sessionId])
  save()
  return true
}

export function createChatSession({ userId, siteId, title }) {
  const id = uid()
  const t = now()
  run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, siteId || null, title || null, t, t])
  return queryOne('SELECT * FROM chat_sessions WHERE id = ?', [id])
}
export function findSessionsByUserAndSite(userId, siteId) {
  return queryAll('SELECT * FROM chat_sessions WHERE user_id = ? AND site_id = ? ORDER BY created_at DESC', [userId, siteId])
}
export function findSessionById(id) {
  return queryOne('SELECT * FROM chat_sessions WHERE id = ?', [id]) || null
}

export function findOrCreateSession(userId, siteId) {
  const sessions = queryAll('SELECT * FROM chat_sessions WHERE user_id = ? AND site_id = ? ORDER BY created_at DESC', [userId, siteId])
  if (sessions.length > 0) return sessions[0]
  return createChatSession({ userId, siteId, title: 'Чат' })
}

// --- Messages (with status) ---
export function createMessage({ sessionId, role, content, metadata, source = 'gateway', status = 'sent' }) {
  const id = uid()
  const meta = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null
  const t = now()
  run('INSERT INTO messages (id, session_id, role, content, metadata, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, sessionId, role, content, meta, source, status, t])
  return { id, session_id: sessionId, role, content, status, created_at: t }
}
export function updateMessageStatus(id, status) {
  run('UPDATE messages SET status = ? WHERE id = ?', [status, id])
}
export function getMessagesBySession(sessionId) {
  return queryAll('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
}

// --- Jobs (queue) ---
export function createJob({ type, siteId, userId, sessionId, payload, maxAttempts = 5 }) {
  const id = uid()
  const t = now()
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
  run('INSERT INTO jobs (id, type, site_id, user_id, session_id, payload_json, status, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, type, siteId || null, userId || null, sessionId || null, payloadStr, 'pending', maxAttempts, t, t, t])
  return id
}
export function claimJob() {
  const t = now()
  // Найти самую старую pending задачу, которая готова к выполнению
  const job = queryOne("SELECT * FROM jobs WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at ASC LIMIT 1", [t])
  if (!job) return null
  run("UPDATE jobs SET status = 'processing', locked_at = ?, locked_by = 'worker', attempts = attempts + 1, updated_at = ? WHERE id = ?",
    [t, t, job.id])
  return queryOne('SELECT * FROM jobs WHERE id = ?', [job.id])
}
export function completeJob(id, result) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
  run("UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, payload_json = ?, updated_at = ? WHERE id = ?",
    [resultStr, now(), id])
}
export function failJob(id, error) {
  const j = queryOne('SELECT * FROM jobs WHERE id = ?', [id])
  if (!j) return
  if (j.attempts >= j.max_attempts) {
    run("UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?",
      [String(error), now(), id])
  } else {
    run("UPDATE jobs SET status = 'pending', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ?, run_after = ? WHERE id = ?",
      [String(error), now(), new Date(Date.now() + 5000).toISOString().replace('T', ' ').slice(0, 19), id])
  }
}
export function getPendingJobCount() {
  return queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'")?.c || 0
}

// --- Audit events ---
export function createAuditEvent({ userId, siteId, sessionId, eventType, entityType, entityId, payload, ipAddress, userAgent, requestId, status }) {
  const id = uid()
  const t = now()
  const payloadStr = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null
  run('INSERT INTO audit_events (id, user_id, site_id, session_id, event_type, entity_type, entity_id, payload_json, ip_address, user_agent, request_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId || null, siteId || null, sessionId || null, eventType, entityType || null, entityId || null, payloadStr, ipAddress || null, userAgent || null, requestId || null, status || null, t])
  return id
}

// ============================================================
// JOB WORKER
// ============================================================
const JOB_HANDLERS = {}

export function registerJobHandler(type, handler) {
  JOB_HANDLERS[type] = handler
}

async function processJob(job) {
  const handler = JOB_HANDLERS[job.type]
  if (!handler) {
    failJob(job.id, 'No handler for type: ' + job.type)
    return
  }
  try {
    const result = await handler(job)
    completeJob(job.id, result)
  } catch (e) {
    failJob(job.id, e.message)
    console.warn('[Worker] Job', job.id, job.type, 'failed:', e.message)
  }
}

// Worker loop — проверяет очередь каждые 2 секунды
let workerRunning = false
async function workerLoop() {
  if (workerRunning) return
  workerRunning = true
  while (true) {
    try {
      const job = claimJob()
      if (job) {
        await processJob(job)
      } else {
        await new Promise(r => setTimeout(r, 2000))
      }
    } catch (e) {
      console.error('[Worker] Loop error:', e.message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

setTimeout(() => workerLoop().catch(() => {}), 1000)

// ============================================================
// PERIODIC SAVE & SHUTDOWN
// ============================================================
setInterval(() => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  save()
}, 10000)

// ============================================================
// STATS
// ============================================================
export function getStats() {
  const users = queryOne('SELECT COUNT(*) as c FROM users')?.c || 0
  const sites = queryOne('SELECT COUNT(*) as c FROM sites')?.c || 0
  const sessions = queryOne('SELECT COUNT(*) as c FROM chat_sessions')?.c || 0
  const messages = queryOne('SELECT COUNT(*) as c FROM messages')?.c || 0
  const messagesByStatus = queryAll('SELECT status, COUNT(*) as c FROM messages GROUP BY status')
  const jobsPending = queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'")?.c || 0
  const jobsFailed = queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'failed'")?.c || 0
  const schemaVer = queryOne('SELECT MAX(version) as v FROM schema_version')?.v || 0
  const recentMessages = queryAll('SELECT role, status, substr(content,1,80) as preview, created_at FROM messages ORDER BY created_at DESC LIMIT 5')
  const recentSites = queryAll('SELECT url, api_token is not null and api_token != \'pending\' as has_token, verified FROM sites ORDER BY created_at DESC LIMIT 10')
  const recentUsers = queryAll('SELECT email, role FROM users ORDER BY created_at DESC')
  return { users, sites, sessions, messages, messagesByStatus, schemaVersion: schemaVer, jobs: { pending: jobsPending, failed: jobsFailed }, recentMessages, recentSites, recentUsers }
}

export function close() {
  if (saveTimer) clearTimeout(saveTimer)
  save()
  db.close()
}

process.on('SIGINT', () => { close(); process.exit(0) })
process.on('SIGTERM', () => { close(); process.exit(0) })
