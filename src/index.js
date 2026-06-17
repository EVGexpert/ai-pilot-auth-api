import { hostname } from 'os'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './routes/auth.js'
import sitesRoutes from './routes/sites.js'
import chatRoutes from './routes/chat.js'
import { config } from './config.js'
import { getStats, getDbHealth } from './db.js'
import { queryOne, close as closeDb, ping, DB_MODE } from './db/connection.js'
import { startWorker, stopWorker } from './db/jobs.js'
import { authMiddleware, adminOnly } from './middleware/auth.js'
import { createLogger } from './utils/logger.js'

const log = createLogger('auth-api')

// ── Instance identity (stable across requests, unique per process) ──
const INSTANCE_ID = process.env.INSTANCE_ID || hostname() || randomUUID()
const START_TIME = Date.now()

// ── Distributed rate limiting: Redis (PG mode) or in-memory fallback ──
let redisClient = null
if (DB_MODE === 'postgresql' && config.REDIS_URL) {
  try {
    const { default: Redis } = await import('ioredis')
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true
    })
    await redisClient.connect()
    const safeUrl = config.REDIS_URL.replace(/\/\/.*@/, '//***@')
    log.info({ event: 'redis_connected', url: safeUrl }, `Redis connected for distributed rate limiting (${safeUrl})`)
  } catch (err) {
    log.warn({ event: 'redis_connection_failed', err: err.message }, 'Redis connection failed — falling back to in-memory rate limiting')
    try { await redisClient?.quit() } catch (_) { /* ignore */ }
    redisClient = null
  }
}
const RATE_LIMITER_MODE = redisClient ? 'redis' : 'memory'

const app = Fastify({
  logger: false,
  genReqId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
})

// ── Trace ID + request logging ──
app.addHook('onRequest', async (request) => {
  request.requestId = request.id
  request.traceId = request.headers['x-trace-id'] || crypto.randomUUID()
  request._startTime = Date.now()
  log.info({
    traceId: request.traceId,
    event: 'request_start',
    method: request.method,
    url: request.url,
    ip: request.ip
  }, `→ ${request.method} ${request.url}`)
})

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Trace-Id', request.traceId || 'generated')
  const duration = Date.now() - (request._startTime || Date.now())
  log.info({
    traceId: request.traceId,
    event: 'request_end',
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    durationMs: duration
  }, `← ${request.method} ${request.url} ${reply.statusCode} ${duration}ms`)
  return payload
})

await app.register(cors, {
  origin: ['https://chat.pilotsite.ru', 'https://pilotsite.ru'],
  credentials: true
})

// Глобальный rate limit (защита от DDoS)
// Redis = shared across instances (PG mode), in-memory = per-instance (SQLite mode)
const rateLimitOptions = {
  global: true,
  max: 1000,
  timeWindow: '1 minute'
}
if (redisClient) {
  rateLimitOptions.redis = redisClient
  rateLimitOptions.nameSpace = 'aipilot:rl:'
}
await app.register(rateLimit, rateLimitOptions)

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(sitesRoutes, { prefix: '/api/sites' })
await app.register(chatRoutes, { prefix: '/api/chat' })

// Healthcheck — без авторизации, проверяет БД, диск, память
app.get('/api/health', async () => {
  const checks = {
    database: false,
    disk: false,
    memory: false,
    redis: redisClient ? false : undefined
  }

  try {
    // ✅ Проверка БД (works for both SQLite and PG)
    await ping()
    checks.database = true
  } catch (e) {
    log.error({ event: 'health_db_check_failed', err: e.message }, 'DB check failed')
  }

  try {
    // ✅ Проверка диска (only for SQLite mode)
    if (DB_MODE === 'sqlite') {
      const { statfsSync } = await import('fs')
      const stats = statfsSync('/app/data')
      checks.disk = stats.bavail / stats.blocks > 0.1  // > 10% свободно
    } else {
      checks.disk = true  // PG mode — no local disk check needed
    }
  } catch (e) {
    log.error({ event: 'health_disk_check_failed', err: e.message }, 'Disk check failed')
  }

  // ✅ Проверка памяти
  const memUsage = process.memoryUsage()
  checks.memory = memUsage.heapUsed / memUsage.heapTotal < 0.9  // < 90%

  // ✅ Проверка Redis (if configured)
  if (redisClient) {
    try {
      const result = await redisClient.ping()
      checks.redis = result === 'PONG'
    } catch (e) {
      log.error({ event: 'health_redis_check_failed', err: e.message }, 'Redis check failed')
    }
  }

  const allChecks = checks.database && checks.disk && checks.memory
  const redisHealthy = !redisClient || checks.redis
  const fullyHealthy = allChecks && redisHealthy

  return {
    status: fullyHealthy ? 'ok' : 'degraded',
    version: '0.4.0',
    instanceId: INSTANCE_ID,
    uptime: Math.floor(process.uptime()),
    cluster: {
      dbMode: DB_MODE,
      rateLimiter: RATE_LIMITER_MODE,
      redis: redisClient ? (checks.redis ? 'connected' : 'disconnected') : 'not_configured'
    },
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
    return reply.send(await getDbHealth())
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Stats — только admin
app.get('/api/stats', { preHandler: [authMiddleware, adminOnly] }, async (request, reply) => {
  try {
    return reply.send({ status: 'ok', ...(await getStats()) })
  } catch (e) {
    return reply.status(500).send({ error: e.message })
  }
})

// Backup — только admin (SQLite mode only)
app.post('/api/backup', { preHandler: [authMiddleware, adminOnly] }, async (request, reply) => {
  if (DB_MODE === 'postgresql') {
    return reply.status(400).send({ error: 'Backup not supported in PostgreSQL mode. Use pg_dump.' })
  }
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

// ============================================================
// /api/metrics — admin only
// ============================================================
app.get('/api/metrics', { preHandler: [authMiddleware, adminOnly] }, async () => {
  const mem = process.memoryUsage()
  const usagePercent = Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100
  return {
    instanceId: INSTANCE_ID,
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      heapExternal: mem.external,
      arrayBuffers: mem.arrayBuffers,
      usagePercent
    },
    cluster: {
      dbMode: DB_MODE,
      rateLimiter: RATE_LIMITER_MODE,
      redis: redisClient ? 'connected' : 'not_configured'
    },
    timestamp: new Date().toISOString()
  }
})

// ============================================================
// Memory monitor — every 30s
// ============================================================
const MEMORY_CHECK_INTERVAL = 30_000
const MEMORY_WARN_THRESHOLD = 0.80
const MEMORY_SHUTDOWN_THRESHOLD = 0.95

const memoryMonitor = setInterval(() => {
  const mem = process.memoryUsage()
  const usage = mem.heapUsed / mem.heapTotal
  const pct = Math.round(usage * 100)
  if (usage >= MEMORY_SHUTDOWN_THRESHOLD) {
    log.error({ event: 'memory_critical', heapPercent: pct }, `Heap usage ${pct}% ≥ 95% — triggering graceful shutdown`)
    gracefulShutdown('OOM')
  } else if (usage >= MEMORY_WARN_THRESHOLD) {
    log.warn({ event: 'memory_warning', heapPercent: pct }, `Heap usage ${pct}% ≥ 80% — consider restarting`)
  }
}, MEMORY_CHECK_INTERVAL)
memoryMonitor.unref() // Don't keep process alive for this timer

// ============================================================
// Graceful shutdown
// ============================================================
let isShuttingDown = false
const SHUTDOWN_TIMEOUT_MS = 30_000

async function gracefulShutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  log.info({ event: 'shutdown_start', signal }, `Received ${signal}, shutting down gracefully...`)

  // Stop memory monitor
  clearInterval(memoryMonitor)

  // Force-exit after timeout
  const forceTimer = setTimeout(() => {
    log.error({ event: 'shutdown_timeout' }, '30s timeout — forcing exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceTimer.unref()

  try {
    // 1. Close HTTP server (stop accepting new connections, drain existing)
    await app.close()
    log.info({ event: 'shutdown_http_closed' }, 'HTTP server closed')
  } catch (err) {
    log.error({ event: 'shutdown_http_error', err: err.message }, 'Error closing HTTP server')
  }

  // Stop worker (finish current job, stop polling)
  try {
    stopWorker()
    log.info({ event: 'shutdown_worker_stopped' }, 'Worker stopped')
  } catch (err) {
    log.error({ event: 'shutdown_worker_error', err: err.message }, 'Error stopping worker')
  }

  try {
    // 3. Close DB
    await closeDb()
    log.info({ event: 'shutdown_db_closed' }, 'DB closed')
  } catch (err) {
    log.error({ event: 'shutdown_db_error', err: err.message }, 'Error closing DB')
  }

  // Close Redis (if connected)
  if (redisClient) {
    try {
      await redisClient.quit()
      log.info({ event: 'shutdown_redis_closed' }, 'Redis connection closed')
    } catch (err) {
      log.error({ event: 'shutdown_redis_error', err: err.message }, 'Error closing Redis')
    }
  }

  log.info({ event: 'shutdown_complete' }, 'Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// ============================================================
// Start server
// ============================================================
const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    log.info({ event: 'server_start', port: config.PORT, dbMode: DB_MODE, rateLimiter: RATE_LIMITER_MODE, instanceId: INSTANCE_ID }, `Auth API v0.4.0 running on port ${config.PORT} (${DB_MODE} mode, rate-limiter: ${RATE_LIMITER_MODE}, instance: ${INSTANCE_ID})`)

    // Start background worker after server is up
    startWorker()
  } catch (err) {
    log.error({ event: 'server_start_error', err: err.message }, 'Server start failed')
    process.exit(1)
  }
}
start()
