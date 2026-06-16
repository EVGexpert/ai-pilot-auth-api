import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './routes/auth.js'
import sitesRoutes from './routes/sites.js'
import chatRoutes from './routes/chat.js'
import { config } from './config.js'
import { getStats, getDbHealth } from './db.js'
import { queryOne } from './db/connection.js'
import { authMiddleware, adminOnly } from './middleware/auth.js'


const app = Fastify({ logger: true, genReqId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8) })

app.addHook('onRequest', async (request) => {
  request.requestId = request.id
})

await app.register(cors, {
  origin: ['https://chat.pilotsite.ru', 'https://pilotsite.ru'],
  credentials: true
})

// Глобальный rate limit (защита от DDoS)
await app.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute'
})

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(sitesRoutes, { prefix: '/api/sites' })
await app.register(chatRoutes, { prefix: '/api/chat' })

// Healthcheck — без авторизации, проверяет БД, диск, память
app.get('/api/health', async () => {
  const checks = {
    database: false,
    disk: false,
    memory: false
  }

  try {
    // ✅ Проверка БД
    queryOne('SELECT 1')
    checks.database = true
  } catch (e) {
    console.error('[Health] DB check failed:', e.message)
  }

  try {
    // ✅ Проверка диска
    const { statfsSync } = await import('fs')
    const stats = statfsSync('/app/data')
    checks.disk = stats.bavail / stats.blocks > 0.1  // > 10% свободно
  } catch (e) {
    console.error('[Health] Disk check failed:', e.message)
  }

  // ✅ Проверка памяти
  const memUsage = process.memoryUsage()
  checks.memory = memUsage.heapUsed / memUsage.heapTotal < 0.9  // < 90%

  const healthy = checks.database && checks.disk && checks.memory

  return {
    status: healthy ? 'ok' : 'degraded',
    version: '0.4.0',
    checks,
    timestamp: new Date().toISOString()
  }
})

// Deploy healthcheck — X-Deploy-Token, без персональных данных
app.get('/api/health/db', async (request, reply) => {
  const deployToken = request.headers['x-deploy-token']
  if (!deployToken) return reply.status(401).send({ error: 'Missing X-Deploy-Token' })
  if (config.DEPLOY_HEALTH_TOKEN && deployToken !== config.DEPLOY_HEALTH_TOKEN) {
    return reply.status(403).send({ error: 'Invalid deploy token' })
  }
  if (!config.DEPLOY_HEALTH_TOKEN && config.isProduction) {
    return reply.status(503).send({ error: 'DEPLOY_HEALTH_TOKEN not configured' })
  }
  try {
    return reply.send(getDbHealth())
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Stats — только admin
app.get('/api/stats', { preHandler: [authMiddleware, adminOnly] }, async (request, reply) => {
  try {
    return reply.send({ status: 'ok', ...getStats() })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Backup — только admin
app.post('/api/backup', { preHandler: [authMiddleware, adminOnly] }, async (request, reply) => {
  try {
    const { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } = await import('fs')
    const path = await import('path')
    const backupDir = path.default.join(path.default.dirname(config.DATABASE_PATH), 'backups')
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
    const date = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19)
    const backupFile = path.default.join(backupDir, 'aipilot-' + date + '.db')
    copyFileSync(config.DATABASE_PATH, backupFile)
    const files = readdirSync(backupDir).filter(f => f.endsWith('.db')).sort()
    while (files.length > 7) { const old = files.shift(); unlinkSync(path.default.join(backupDir, old)) }
    return reply.send({ status: 'ok', backup: backupFile, kept: 7 })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    console.log(`Auth API v0.4.0 running on port ${config.PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()
