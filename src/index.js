import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './routes/auth.js'
import sitesRoutes from './routes/sites.js'
import chatRoutes from './routes/chat.js'
import { config } from './config.js'
import { getStats, getDbHealth } from './db.js'
import { authMiddleware, adminOnly } from './middleware/auth.js'


const app = Fastify({ logger: true, genReqId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8) })

app.addHook('onRequest', async (request) => {
  request.requestId = request.id
})

await app.register(cors, {
  origin: ['https://chat.pilotsite.ru', 'https://pilotsite.ru'],
  credentials: true
})

await app.register(rateLimit, {
  max: 20,
  timeWindow: '1 minute'
})

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(sitesRoutes, { prefix: '/api/sites' })
await app.register(chatRoutes, { prefix: '/api/chat' })

// Simple healthcheck (без авторизации)
app.get('/api/health', async () => ({ status: 'ok', version: '0.3.0' }))

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
    console.log(`Auth API v0.3.0 running on port ${config.PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()
