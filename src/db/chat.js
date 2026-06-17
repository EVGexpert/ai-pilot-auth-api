import { queryOne, queryAll, run, uid, now } from './connection.js'

export async function createChatSession({ userId, siteId, title }) {
  const id = uid(); const t = now()
  await run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [id, userId, siteId || null, title || null, t, t])
  return { id, user_id: userId, site_id: siteId, title, created_at: t, updated_at: t }
}
export async function findSessionsByUserAndSite(userId, siteId) {
  return await queryAll('SELECT * FROM chat_sessions WHERE user_id = ? AND site_id = ? ORDER BY created_at DESC', [userId, siteId])
}
export async function findSessionById(id) {
  return await queryOne('SELECT * FROM chat_sessions WHERE id = ?', [id]) || null
}
export async function findOrCreateSession(userId, siteId) {
  const sessions = await queryAll('SELECT * FROM chat_sessions WHERE user_id = ? AND site_id = ? ORDER BY created_at DESC', [userId, siteId])
  if (sessions.length > 0) return sessions[0]
  return await createChatSession({ userId, siteId, title: 'Чат' })
}

export async function createMessage({ sessionId, role, content, metadata, source = 'gateway', status = 'sent' }) {
  const id = uid(); const t = now()
  const meta = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null
  await run('INSERT INTO messages (id, session_id, role, content, metadata, source, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, sessionId, role, content, meta, source, status, t])
  return { id, session_id: sessionId, role, content, status, created_at: t }
}
export async function updateMessageStatus(id, status) {
  await run('UPDATE messages SET status = ? WHERE id = ?', [status, id])
}
export async function getMessagesBySession(sessionId) {
  return await queryAll('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
}

export async function updateSessionSummary(sessionId) {
  const msgs = await queryAll('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId])
  if (msgs.length < 12) return false
  const oldMsgs = msgs.slice(0, msgs.length - 12).filter(m => m.role !== 'system')
  if (oldMsgs.length < 3) return false
  const summary = oldMsgs.map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join(' | ').slice(0, 2000)
  await run('UPDATE chat_sessions SET summary = ?, summary_updated_at = ? WHERE id = ?', [summary, new Date().toISOString(), sessionId])
  return true
}
