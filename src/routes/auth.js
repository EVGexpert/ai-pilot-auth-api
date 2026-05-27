import { nanoid } from 'nanoid'
import { hashPassword, verifyPassword } from '../password.js'
import { findUserByEmail, findUserById, createUser, updateUser,
         createVerification, findVerification, deleteVerificationsByUser,
         findSitesByUser, allSites } from '../db.js'
import { generateToken } from '../middleware/auth.js'
import { sendVerificationEmail } from '../email.js'

export default async function authRoutes(app) {

  // Регистрация
  app.post('/register', async (request, reply) => {
    const { email, password, name } = request.body || {}
    if (!email || !password) return reply.status(400).send({ error: 'Email и пароль обязательны' })
    if (password.length < 6) return reply.status(400).send({ error: 'Пароль минимум 6 символов' })

    if (findUserByEmail(email)) return reply.status(409).send({ error: 'Email уже зарегистрирован' })

    // admin@pilot.ru и admin-email → роль admin
    const role = email.includes('admin') ? 'admin' : 'client'
    const passwordHash = await hashPassword(password)
    const user = createUser({ email, passwordHash, name, role })

    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    createVerification(user.id, code)

    try { await sendVerificationEmail(email, code) } catch (err) { console.error('Email failed:', err.message) }

    const token = generateToken(user)
    return reply.status(201).send({
      token, user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: false },
      message: 'Подтвердите email. Код отправлен на почту.'
    })
  })

  // Вход
  app.post('/login', async (request, reply) => {
    const { email, password } = request.body || {}
    if (!email || !password) return reply.status(400).send({ error: 'Email и пароль обязательны' })

    const user = findUserByEmail(email)
    if (!user) return reply.status(401).send({ error: 'Неверный email или пароль' })

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) return reply.status(401).send({ error: 'Неверный email или пароль' })

    const token = generateToken(user)
    // Админ видит ВСЕ уникальные сайты
    let siteList
    if (user.role === 'admin') {
      const seen = new Set()
      siteList = allSites().filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      })
    } else {
      siteList = findSitesByUser(user.id)
    }
    const sites = siteList.map(s => ({
      id: s.id, url: s.url, name: s.name, wp_version: s.wp_version
    }))

    return reply.send({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: !!user.email_verified },
      sites
    })
  })

  // Подтверждение email
  app.post('/verify-email', async (request, reply) => {
    const { email, code } = request.body || {}
    const user = findUserByEmail(email)
    if (!user) return reply.status(404).send({ error: 'Пользователь не найден' })

    const verification = findVerification(user.id, code)
    if (!verification) return reply.status(400).send({ error: 'Неверный или просроченный код' })

    updateUser(user.id, { email_verified: 1 })
    deleteVerificationsByUser(user.id)
    return reply.send({ message: 'Email подтверждён' })
  })

  // Информация о пользователе
  app.get('/me', {
    preHandler: async (request, reply) => {
      const auth = request.headers.authorization
      if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' })
      const { verifyToken } = await import('../middleware/auth.js')
      const payload = verifyToken(auth.slice(7))
      if (!payload) return reply.status(401).send({ error: 'Invalid token' })
      request.user = payload
    }
  }, async (request, reply) => {
    const user = findUserById(request.user.sub)
    if (!user) return reply.status(404).send({ error: 'User not found' })
    const sites = findSitesByUser(user.id).map(s => ({
      id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, created_at: s.created_at
    }))
    return reply.send({ user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: !!user.email_verified }, sites })
  })
}
