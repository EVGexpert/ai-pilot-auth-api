import crypto from 'crypto'
import { queryOne, queryAll, run, uid, now } from './connection.js'

/**
 * Создать refresh token.
 * В БД хранится ТОЛЬКО SHA256-хэш токена.
 * Возвращает сырой токен (для отдачи клиенту).
 */
export async function createRefreshToken(userId, userAgent = null, ipAddress = null) {
  const rawToken = uid() + uid() + uid()  // ~36 символов
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

  // 30 дней
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  await run(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uid(), userId, tokenHash, expiresAt, now(), userAgent || null, ipAddress || null])

  return rawToken
}

/**
 * Найти refresh token по сырому значению.
 * Проверяет: не истёк, не отозван.
 * Возвращает { id, user_id, token_hash, created_at } или null.
 */
export async function findValidRefreshToken(rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  const nowStr = now()
  const row = await queryOne(`SELECT id, user_id, token_hash, created_at
    FROM refresh_tokens
    WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`,
    [tokenHash, nowStr])
  return row || null
}

/**
 * Отозвать refresh token.
 */
export async function revokeRefreshToken(rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  await run(`UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`, [now(), tokenHash])
}

/**
 * Отозвать ВСЕ refresh токены пользователя.
 * Используется при смене пароля или подозрительной активности.
 */
export async function revokeAllUserTokens(userId) {
  await run(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now(), userId])
}

/**
 * Очистить истёкшие и отозванные токены старше N дней.
 */
export async function cleanExpiredTokens(maxAgeDays = 90) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  await run(`DELETE FROM refresh_tokens
    WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
    OR (expires_at < ?)`,
    [cutoff, cutoff])
}
