import { existsSync, statSync } from 'fs'
import { createLogger } from './utils/logger.js'

const log = createLogger('config')

export const APP_VERSION = '0.4.0'

export const NODE_ENV = process.env.NODE_ENV || 'development'
const isProduction = NODE_ENV === 'production'

// Валидация production-окружения при импорте
// (не ждём вызова функции — умираем сразу)
function validateProductionConfig() {
  if (!isProduction) return

  // DATABASE_PATH или DATABASE_URL обязателен
  if (!process.env.DATABASE_PATH && !process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_PATH or DATABASE_URL is required in production. ' +
      'Example: DATABASE_PATH=/app/data/aipilot.db or DATABASE_URL=postgresql://user:pass@host:5432/db'
    )
  }

  // Запрещаем опасные пути для БД (только для SQLite mode)
  if (process.env.DATABASE_PATH) {
    const dangerousPaths = ['/tmp', '/var/tmp', '/dev/shm', '/app/src', '/src', './src']
    const dbPath = process.env.DATABASE_PATH
    for (const bad of dangerousPaths) {
      if (dbPath.startsWith(bad)) {
        throw new Error(
          `DATABASE_PATH (${dbPath}) points to a temporary or source directory. ` +
          `Use a persistent volume path like /app/data/`
        )
      }
    }
  }

  // JWT_SECRET обязателен
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is required in production. ' +
      'Generate one: openssl rand -hex 32'
    )
  }

  // Минимальная длина JWT_SECRET
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error(
      'JWT_SECRET must be at least 32 characters in production. ' +
      'Generate one: openssl rand -hex 32'
    )
  }

  // DEPLOY_HEALTH_TOKEN обязателен (для healthcheck при деплое)
  if (!process.env.DEPLOY_HEALTH_TOKEN) {
    throw new Error(
      'DEPLOY_HEALTH_TOKEN is required in production. ' +
      'Set it in GitHub Secrets: DEPLOY_HEALTH_TOKEN, also in docker run -e DEPLOY_HEALTH_TOKEN=...'
    )
  }
}

validateProductionConfig()

// DEV-предупреждения
if (!isProduction) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-in-production') {
    log.warn({ event: 'dev_jwt_secret' }, 'Using dev JWT_SECRET — not suitable for production')
  }
}

export const config = {
  PORT: parseInt(process.env.PORT || '3001'),
  NODE_ENV,
  isProduction,
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  ACCESS_TOKEN_EXPIRES_IN: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  DATABASE_URL: process.env.DATABASE_URL || null,
  DATABASE_PATH: process.env.DATABASE_PATH || './data/aipilot.db',
  APP_URL: process.env.APP_URL || 'https://pilotsite.ru',
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587'),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  GATEWAY_TOKEN: process.env.GATEWAY_TOKEN,
  DEPLOY_HEALTH_TOKEN: process.env.DEPLOY_HEALTH_TOKEN,
  GATEWAY_WS: process.env.GATEWAY_WS || 'ws://localhost:18789',
  REDIS_URL: process.env.REDIS_URL || null
}

// Безопасная диагностика при старте
if (config.DATABASE_PATH) {
  const dbPath = config.DATABASE_PATH
  const exists = existsSync(dbPath)
  let size = 0
  if (exists) {
    try { size = statSync(dbPath).size } catch (e) { /* ignore */ }
  }
  log.info({ event: 'db_path', dbPath, exists, size }, `DB path: ${dbPath} (exists: ${exists}, size: ${size} bytes)`)
}
