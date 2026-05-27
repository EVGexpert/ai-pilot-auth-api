import { queryOne, queryAll, run, uid, now } from './connection.js'

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
  run('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)',
    [id, email, passwordHash, name || null, role, t, t])
  return findUserById(id)
}
export function updateUser(id, fields) {
  const sets = []; const params = []
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name) }
  if (fields.email_verified !== undefined) { sets.push('email_verified = ?'); params.push(fields.email_verified) }
  if (sets.length === 0) return findUserById(id)
  params.push(now(), id)
  run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params)
  return findUserById(id)
}

// --- Email verifications ---
export function createVerification(userId, code) {
  const id = uid()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  run('INSERT INTO email_verifications (id, user_id, code, expires_at, created_at) VALUES (?,?,?,?,?)',
    [id, userId, code, expiresAt, now()])
  return { id, user_id: userId, code, expires_at: expiresAt, created_at: now() }
}
export function findVerification(userId, code) {
  return queryOne('SELECT * FROM email_verifications WHERE user_id = ? AND code = ? AND expires_at > ?', [userId, code, now()])
}
export function deleteVerificationsByUser(userId) {
  run('DELETE FROM email_verifications WHERE user_id = ?', [userId])
}
