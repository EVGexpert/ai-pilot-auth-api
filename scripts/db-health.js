#!/usr/bin/env node
/**
 * DB Health Check Script
 *
 * Проверяет SQLite-БД напрямую, без запуска HTTP-сервера.
 * Используется в deploy.yml для проверки целостности данных.
 *
 * Использование:
 *   node scripts/db-health.js
 *   DATABASE_PATH=/app/data/aipilot.db node scripts/db-health.js
 *
 * JSON-вывод:
 *   { "status": "ok", "databasePath": "...", "databaseExists": true, ... }
 *
 * Exit codes:
 *   0 — OK (БД есть или её нет — но проверка прошла)
 *   1 — Ошибка чтения БД или БД повреждена
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'fs'

function main() {
  const dbPath = process.env.DATABASE_PATH || './data/aipilot.db'
  const result = {
    status: 'ok',
    databasePath: dbPath,
    databaseExists: false,
    databaseSizeBytes: 0,
    users: 0,
    sites: 0,
    sessions: 0,
    messages: 0,
    schemaVersion: 0
  }

  if (!existsSync(dbPath)) {
    // БД не существует — это нормально для первого запуска
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  }

  const stat = statSync(dbPath)
  result.databaseExists = true
  result.databaseSizeBytes = stat.size

  if (stat.size === 0) {
    // Пустой файл — это ошибка
    result.status = 'empty'
    console.log(JSON.stringify(result, null, 2))
    process.exit(1)
  }

  try {
    const db = new DatabaseSync(dbPath)

    try {
      const users = db.prepare('SELECT COUNT(*) as c FROM users').get()
      result.users = users?.c || 0

      const sites = db.prepare('SELECT COUNT(*) as c FROM sites').get()
      result.sites = sites?.c || 0

      const sessions = db.prepare('SELECT COUNT(*) as c FROM chat_sessions').get()
      result.sessions = sessions?.c || 0

      const messages = db.prepare('SELECT COUNT(*) as c FROM messages').get()
      result.messages = messages?.c || 0

      const schema = db.prepare('SELECT MAX(version) as v FROM schema_version').get()
      result.schemaVersion = schema?.v || 0
    } catch (queryErr) {
      // Таблицы могут ещё не существовать — это нормально для свежей БД
      result.status = 'partial'
    }

    db.close()
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      databasePath: dbPath,
      error: err.message
    }, null, 2))
    process.exit(1)
  }
}

main()
