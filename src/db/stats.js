import { queryOne, queryAll, DB_PATH, DB_MODE } from './connection.js'
import { existsSync, statSync } from 'fs'

export async function getStats() {
  const users = (await queryOne('SELECT COUNT(*) as c FROM users'))?.c || 0
  const sites = (await queryOne('SELECT COUNT(*) as c FROM sites'))?.c || 0
  const sessions = (await queryOne('SELECT COUNT(*) as c FROM chat_sessions'))?.c || 0
  const messages = (await queryOne('SELECT COUNT(*) as c FROM messages'))?.c || 0
  const messagesByStatus = await queryAll('SELECT status, COUNT(*) as c FROM messages GROUP BY status')
  const jobsPending = (await queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'"))?.c || 0
  const jobsFailed = (await queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'failed'"))?.c || 0
  const schemaVer = (await queryOne('SELECT MAX(version) as v FROM schema_version'))?.v || 0
  const recentMessages = await queryAll('SELECT role, status, substr(content,1,80) as preview, created_at FROM messages ORDER BY created_at DESC LIMIT 5')
  const recentSites = await queryAll('SELECT url, api_token is not null and api_token != \'pending\' as has_token, verified FROM sites ORDER BY created_at DESC LIMIT 10')
  const recentUsers = await queryAll('SELECT email, role FROM users ORDER BY created_at DESC')
  return { users, sites, sessions, messages, messagesByStatus, schemaVersion: schemaVer, jobs: { pending: jobsPending, failed: jobsFailed }, recentMessages, recentSites, recentUsers }
}

/**
 * Безопасный healthcheck для deploy — без персональных данных.
 * Может быть вызван даже с неполной схемой (свежая БД).
 */
export async function getDbHealth() {
  if (DB_MODE === 'postgresql') {
    // PostgreSQL mode — no file to check
    let users = 0, sites = 0, sessions = 0, messages = 0, schemaVersion = 0

    try {
      users = (await queryOne('SELECT COUNT(*) as c FROM users'))?.c || 0
      sites = (await queryOne('SELECT COUNT(*) as c FROM sites'))?.c || 0
      sessions = (await queryOne('SELECT COUNT(*) as c FROM chat_sessions'))?.c || 0
      messages = (await queryOne('SELECT COUNT(*) as c FROM messages'))?.c || 0
      schemaVersion = (await queryOne('SELECT MAX(version) as v FROM schema_version'))?.v || 0
    } catch (e) {
      // Tables not yet created — fresh DB
    }

    return {
      status: 'ok',
      dbMode: 'postgresql',
      users,
      sites,
      sessions,
      messages,
      schemaVersion
    }
  }

  // SQLite mode — check file
  const exists = existsSync(DB_PATH)
  let size = 0
  if (exists) {
    try { size = statSync(DB_PATH).size } catch (e) { /* ignore */ }
  }

  let users = 0, sites = 0, sessions = 0, messages = 0, schemaVersion = 0

  if (exists && size > 0) {
    try {
      users = (await queryOne('SELECT COUNT(*) as c FROM users'))?.c || 0
      sites = (await queryOne('SELECT COUNT(*) as c FROM sites'))?.c || 0
      sessions = (await queryOne('SELECT COUNT(*) as c FROM chat_sessions'))?.c || 0
      messages = (await queryOne('SELECT COUNT(*) as c FROM messages'))?.c || 0
      schemaVersion = (await queryOne('SELECT MAX(version) as v FROM schema_version'))?.v || 0
    } catch (e) {
      // Таблицы ещё не созданы — свежая БД, это нормально
    }
  }

  return {
    status: 'ok',
    dbMode: 'sqlite',
    databasePath: DB_PATH,
    databaseExists: exists,
    databaseSizeBytes: size,
    users,
    sites,
    sessions,
    messages,
    schemaVersion
  }
}
