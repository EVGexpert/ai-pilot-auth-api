import { queryOne, queryAll } from './connection.js'

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
