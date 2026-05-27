import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './routes/auth.js'
import sitesRoutes from './routes/sites.js'
import chatRoutes from './routes/chat.js'
import { config } from './config.js'
import { getStats } from './db.js'
import { verifyToken } from './middleware/auth.js'


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

app.get('/api/health', async () => ({ status: 'ok', version: '0.3.0' }))

// Protected: only admin can see stats
app.get('/api/stats', async (request, reply) => {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' })
  const payload = verifyToken(auth.slice(7))
  if (!payload || payload.role !== 'admin') return reply.status(403).send({ error: 'Admin only' })
  try {
    return reply.send({ status: 'ok', ...getStats() })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Protected: only admin can trigger backup
app.post('/api/backup', async (request, reply) => {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' })
  const payload = verifyToken(auth.slice(7))
  if (!payload || payload.role !== 'admin') return reply.status(403).send({ error: 'Admin only' })
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
