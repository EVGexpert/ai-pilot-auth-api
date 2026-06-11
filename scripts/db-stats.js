#!/usr/bin/env node
/**
 * DB Stats Script
 *
 * Выводит агрегаты SQLite-БД для проверки целостности backup'ов.
 *
 * Использование:
 *   node scripts/db-stats.js <путь-к-файлу.db>
 *   node scripts/db-stats.js /root/ai-pilot-web-chat/auth-data/aipilot.db
 *   node scripts/db-stats.js backups/aipilot_20261106_120000.db
 *
 * Выход: JSON с агрегатами или объект с ошибкой.
 * Exit code: 0 = OK, 1 = ошибка
 */

import initSqlJs from 'sql.js'
import { readFileSync, existsSync, statSync } from 'fs'
import path from 'path'

async function main() {
  const dbPath = process.argv[2] || process.env.DATABASE_PATH || './data/aipilot.db'

  const result = {
    file: path.resolve(dbPath),
    exists: false,
    sizeBytes: 0,
    users: 0,
    sites: 0,
    chat_sessions: 0,
    messages: 0,
    action_requests: 0,
    jobs: 0,
    audit_events: 0,
    schema_version: 0,
    status: 'unknown'
  }

  if (!existsSync(dbPath)) {
    result.status = 'not_found'
    result.error = 'File not found'
    console.log(JSON.stringify(result, null, 2))
    process.exit(1)
  }

  const stat = statSync(dbPath)
  result.exists = true
  result.sizeBytes = stat.size

  if (stat.size === 0) {
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

    const tables = [
      'users', 'sites', 'chat_sessions', 'messages',
      'action_requests', 'jobs', 'audit_events'
    ]

    for (const table of tables) {
      try {
        const rows = db.exec(`SELECT COUNT(*) as c FROM ${table}`)
        result[table] = rows[0]?.values[0][0] || 0
      } catch (e) {
        // Таблица может отсутствовать
        result[table] = -1
      }
    }

    try {
      const schema = db.exec('SELECT MAX(version) as v FROM schema_version')
      result.schema_version = schema[0]?.values[0][0] || 0
    } catch (e) {
      result.schema_version = -1
    }

    db.close()
    result.status = 'ok'
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (err) {
    result.status = 'error'
    result.error = err.message
    console.log(JSON.stringify(result, null, 2))
    process.exit(1)
  }
}

main()
