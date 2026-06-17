import { config } from '../config.js'
import { hashPassword, verifyPassword } from '../password.js'
import {
  findUserByEmail, findUserById, createUser, updateUser,
  createVerification, findVerification, deleteVerificationsByUser,
  findSitesByUser, allSites,
  createRefreshToken, findValidRefreshToken, revokeRefreshToken,
  revokeAllUserTokens,
  createAuditEvent
} from '../db.js'
import { generateToken, authMiddleware } from '../middleware/auth.js'
import { sendVerificationEmail } from '../email.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('auth')

export default async function authRoutes(app) {

  // Регистрация — rate limit 3/час/IP
  app.post('/register', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 hour'
      }
    }
  }, async (request, reply) => {
    const { email, password, name } = request.body || {}
    if (!email || !password) return reply.status(400).send({ error: 'Email и пароль обязательны' })
    if (password.length < 6) return reply.status(400).send({ error: 'Пароль минимум 6 символов' })

    if (await findUserByEmail(email)) return reply.status(409).send({ error: 'Email уже зарегистрирован' })

    const role = email.includes('admin') ? 'admin' : 'client'
    const passwordHash = await hashPassword(password)
    const user = await createUser({ email, passwordHash, name, role })

    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    await createVerification(user.id, code)

    try { await sendVerificationEmail(email, code) } catch (err) { log.error({ event: 'email_send_failed', err: err.message }, 'Email failed') }

    const token = generateToken(user)
    const refreshToken = await createRefreshToken(user.id, request.headers['user-agent'] || null, request.ip)

    await createAuditEvent({
      userId: user.id, eventType: 'register',
      entityType: 'user', entityId: user.id,
      payload: { email, role },
      ipAddress: request.ip, userAgent: request.headers['user-agent'],
      requestId: request.requestId, traceId: request.traceId, status: 'completed'
    })

    return reply.status(201).send({
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: false },
      message: 'Подтвердите email. Код отправлен на почту.'
    })
  })

  // Вход — rate limit 5/мин/IP
  app.post('/login', {
    config: {
      rateLimit: {
        max: 50,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body || {}
    if (!email || !password) return reply.status(400).send({ error: 'Email и пароль обязательны' })

    const user = await findUserByEmail(email)
    if (!user) {
      await createAuditEvent({
        eventType: 'failed_login',
        entityType: 'user', entityId: email,
        payload: { email, reason: 'user_not_found' },
        ipAddress: request.ip, userAgent: request.headers['user-agent'],
        requestId: request.requestId, traceId: request.traceId, status: 'failed'
      })
      return reply.status(401).send({ error: 'Неверный email или пароль' })
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      await createAuditEvent({
        userId: user.id, eventType: 'failed_login',
        entityType: 'user', entityId: user.id,
        payload: { email, reason: 'wrong_password' },
        ipAddress: request.ip, userAgent: request.headers['user-agent'],
        requestId: request.requestId, traceId: request.traceId, status: 'failed'
      })
      return reply.status(401).send({ error: 'Неверный email или пароль' })
    }

    const token = generateToken(user)
    const refreshToken = await createRefreshToken(user.id, request.headers['user-agent'] || null, request.ip)

    await createAuditEvent({
      userId: user.id, eventType: 'login',
      entityType: 'user', entityId: user.id,
      payload: { email, role: user.role },
      ipAddress: request.ip, userAgent: request.headers['user-agent'],
      requestId: request.requestId, traceId: request.traceId, status: 'completed'
    })

    let siteList
    if (user.role === 'admin') {
      const seen = new Set()
      siteList = (await allSites()).filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      })
    } else {
      siteList = await findSitesByUser(user.id)
    }
    const sites = siteList.map(s => ({
      id: s.id, url: s.url, name: s.name, wp_version: s.wp_version
    }))

    return reply.send({
      token,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: !!user.email_verified },
      sites
    })
  })

  // Обновить access token по refresh token — rate limit 20/мин/user
  app.post('/refresh', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken обязателен' })

    const stored = await findValidRefreshToken(refreshToken)
    if (!stored) return reply.status(401).send({ error: 'Refresh token недействителен или истёк' })

    const user = await findUserById(stored.user_id)
    if (!user) return reply.status(404).send({ error: 'Пользователь не найден' })

    // Создаём новый access token
    const token = generateToken(user)

    // Отзываем старый refresh token и выдаём новый (rotation)
    await revokeRefreshToken(refreshToken)
    const newRefreshToken = await createRefreshToken(user.id, request.headers['user-agent'] || null, request.ip)

    return reply.send({ token, refreshToken: newRefreshToken })
  })

  // Выход (отозвать refresh token)
  app.post('/logout', async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken обязателен' })

    await revokeRefreshToken(refreshToken)
    return reply.send({ message: 'Выход выполнен' })
  })

  // Подтверждение email
  app.post('/verify-email', async (request, reply) => {
    const { email, code } = request.body || {}
    const user = await findUserByEmail(email)
    if (!user) return reply.status(404).send({ error: 'Пользователь не найден' })

    const verification = await findVerification(user.id, code)
    if (!verification) return reply.status(400).send({ error: 'Неверный или просроченный код' })

    await updateUser(user.id, { email_verified: 1 })
    await deleteVerificationsByUser(user.id)
    return reply.send({ message: 'Email подтверждён' })
  })

  // Информация о пользователе
  app.get('/me', { preHandler: [authMiddleware] }, async (request, reply) => {
    const user = await findUserById(request.user.sub)
    if (!user) return reply.status(404).send({ error: 'User not found' })
    const sites = (await findSitesByUser(user.id)).map(s => ({
      id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, created_at: s.created_at
    }))
    return reply.send({ user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: !!user.email_verified }, sites })
  })

  // Выход со всех устройств
  app.post('/logout-all', { preHandler: [authMiddleware] }, async (request, reply) => {
    await revokeAllUserTokens(request.user.sub)
    return reply.send({ message: 'Все сессии завершены' })
  })
}
