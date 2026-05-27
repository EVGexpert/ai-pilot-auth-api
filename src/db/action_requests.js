import { queryOne, queryAll, run, uid, now } from './connection.js'
import { createHash, randomBytes } from 'crypto'

/**
 * Сгенерировать idempotency key на основе действия.
 * Одинаковые действия → одинаковый ключ → защита от дублей.
 */
export function generateActionKey(action) {
  const raw = JSON.stringify({ type: action.type, target: action.target, patch: action.patch })
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Создать запрос действия с idempotency ключом.
 * Если действие с таким ключом уже существует — возвращает существующее.
 */
export function createActionRequest({ userId, siteId, sessionId, action }) {
  const key = action.idempotency_key || generateActionKey(action)

  // Проверяем, есть ли уже такое действие
  const existing = queryOne('SELECT * FROM action_requests WHERE idempotency_key = ?', [key])
  if (existing) return existing

  const id = uid(); const t = now()
  run(`INSERT INTO action_requests (id, user_id, site_id, session_id, idempotency_key, action_type, action_json, status, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    [id, userId, siteId || null, sessionId || null, key, action.type, JSON.stringify(action), t, t])
  return queryOne('SELECT * FROM action_requests WHERE id = ?', [id])
}

/**
 * Получить запрос действия по idempotency ключу.
 */
export function findActionByKey(key) {
  return queryOne('SELECT * FROM action_requests WHERE idempotency_key = ?', [key])
}

/**
 * Обновить статус действия.
 */
export function updateActionStatus(id, status, result = null) {
  const sets = ["status = ?", "updated_at = ?"]
  const params = [status, now()]
  if (result !== null) {
    sets.push("result_json = ?")
    params.push(typeof result === 'string' ? result : JSON.stringify(result))
  }
  params.push(id)
  run(`UPDATE action_requests SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * Получить все действия для сессии.
 */
export function getActionsBySession(sessionId, includeDone = false) {
  const statusFilter = includeDone ? '' : "AND status = 'pending'"
  return queryAll(`SELECT * FROM action_requests WHERE session_id = ? ${statusFilter} ORDER BY created_at ASC`, [sessionId])
}
