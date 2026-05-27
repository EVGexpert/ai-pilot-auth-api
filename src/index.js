import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './routes/auth.js'
import sitesRoutes from './routes/sites.js'
import chatRoutes from './routes/chat.js'
import { config } from './config.js'
import { getStats } from './db.js'


const app = Fastify({ logger: true, genReqId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8) })

// Request ID для всех запросов
app.addHook('onRequest', async (request) => {
  request.requestId = request.id
})

// CORS — разрешаем чат
await app.register(cors, {
  origin: ['https://chat.pilotsite.ru', 'https://pilotsite.ru'],
  credentials: true
})

// Rate limit — защита от брутфорса
await app.register(rateLimit, {
  max: 20,
  timeWindow: '1 minute'
})

// Роуты
await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(sitesRoutes, { prefix: '/api/sites' })
await app.register(chatRoutes, { prefix: '/api/chat' })

// Health check
app.get('/api/health', async () => ({ status: 'ok', version: '0.2.0' }))

// Статистика БД
app.get('/api/stats', async (request, reply) => {
  try {
    const stats = getStats()
    return reply.send({ status: 'ok', ...stats })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Backup endpoint — копирует БД в бэкап
app.post('/api/backup', async (request, reply) => {
  try {
    const { copyFileSync, existsSync, mkdirSync } = await import('fs')
    const path = await import('path')
    const backupDir = path.default.join(path.default.dirname(config.DATABASE_PATH), 'backups')
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
    const date = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19)
    const backupFile = path.default.join(backupDir, 'aipilot-' + date + '.db')
    copyFileSync(config.DATABASE_PATH, backupFile)
    // Оставляем только последние 7 бэкапов
    const { readdirSync, unlinkSync } = await import('fs')
    const files = readdirSync(backupDir).filter(f => f.endsWith('.db')).sort()
    while (files.length > 7) {
      const old = files.shift()
      unlinkSync(path.default.join(backupDir, old))
    }
    return reply.send({ status: 'ok', backup: backupFile, kept: 7 })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

const start = async () => {
  try {
    const port = config.PORT
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`Auth API running on port ${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
