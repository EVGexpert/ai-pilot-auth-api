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

import initSqlJs from 'sql.js'
import { readFileSync, existsSync, statSync } from 'fs'

async function main() {
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
    const SQL = await initSqlJs({
      locateFile: file => new URL('../node_modules/sql.js/dist/' + file, import.meta.url).pathname
    })

    const buffer = readFileSync(dbPath)
    const db = new SQL.Database(buffer)

    try {
      const users = db.exec('SELECT COUNT(*) as c FROM users')
      result.users = (users[0]?.values[0][0]) || 0

      const sites = db.exec('SELECT COUNT(*) as c FROM sites')
      result.sites = (sites[0]?.values[0][0]) || 0

      const sessions = db.exec('SELECT COUNT(*) as c FROM chat_sessions')
      result.sessions = (sessions[0]?.values[0][0]) || 0

      const messages = db.exec('SELECT COUNT(*) as c FROM messages')
      result.messages = (messages[0]?.values[0][0]) || 0

      const schema = db.exec('SELECT MAX(version) as v FROM schema_version')
      result.schemaVersion = (schema[0]?.values[0][0]) || 0
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
