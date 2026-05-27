import { queryOne, queryAll, run, uid, now } from './connection.js'

export function createChatSession({ userId, siteId, title }) {
  const id = uid(); const t = now()
  run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [id, userId, siteId || null, title || null, t, t])
  return { id, user_id: userId, site_id: siteId, title, created_at: t, updated_at: t }
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

export function createMessage({ sessionId, role, content, metadata, source = 'gateway', status = 'sent' }) {
  const id = uid(); const t = now()
  const meta = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null
  run('INSERT INTO messages (id, session_id, role, content, metadata, source, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, sessionId, role, content, meta, source, status, t])
  return { id, session_id: sessionId, role, content, status, created_at: t }
}
export function updateMessageStatus(id, status) {
  run('UPDATE messages SET status = ? WHERE id = ?', [status, id])
}
export function getMessagesBySession(sessionId) {
  return queryAll('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
}

export function updateSessionSummary(sessionId) {
  const msgs = queryAll('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
  if (msgs.length < 12) return false
  const oldMsgs = msgs.slice(0, msgs.length - 12).filter(m => m.role !== 'system')
  if (oldMsgs.length < 3) return false
  const summary = oldMsgs.map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join(' | ').slice(0, 2000)
  run('UPDATE chat_sessions SET summary = ?, summary_updated_at = ? WHERE id = ?', [summary, new Date().toISOString(), sessionId])
  return true
}
