#!/usr/bin/env node
/**
 * migrate-sqlite-to-pg.js — Migrate data from SQLite to PostgreSQL
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pass@host:5432/dbname node scripts/migrate-sqlite-to-pg.js
 *
 * Optional:
 *   SQLITE_PATH=./data/aipilot.db   — path to SQLite database (default: ./data/aipilot.db)
 *   DRY_RUN=true                    — show counts without writing to PG
 */

import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SQLITE_PATH = process.env.SQLITE_PATH || './data/aipilot.db'
const DATABASE_URL = process.env.DATABASE_URL
const DRY_RUN = process.env.DRY_RUN === 'true'

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is required')
  console.error('   Example: DATABASE_URL=postgresql://user:pass@host:5432/dbname node scripts/migrate-sqlite-to-pg.js')
  process.exit(1)
}

// Tables to migrate, in dependency order
const TABLES = [
  'users',
  'sites',
  'email_verifications',
  'chat_sessions',
  'messages',
  'jobs',
  'audit_events',
  'config',
  'site_memory',
  'action_requests',
  'refresh_tokens',
  'schema_version'
]

async function migrate() {
  console.log('═══════════════════════════════════════')
  console.log('  SQLite → PostgreSQL Migration')
  console.log('═══════════════════════════════════════')
  console.log(`  SQLite:  ${SQLITE_PATH}`)
  console.log(`  PG:      ${DATABASE_URL.replace(/:([^@]+)@/, ':****@')}`)
  console.log(`  Dry run: ${DRY_RUN}`)
  console.log('═══════════════════════════════════════')
  console.log()

  // ──── Open SQLite ────
  let sqlite
  try {
    sqlite = new DatabaseSync(SQLITE_PATH, { readonly: true })
    console.log('✅ SQLite opened (read-only)')
  } catch (e) {
    console.error('❌ Failed to open SQLite:', e.message)
    process.exit(1)
  }

  // ──── Connect to PG ────
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 })
  try {
    const client = await pool.connect()
    console.log('✅ PostgreSQL connected')
    client.release()
  } catch (e) {
    console.error('❌ Failed to connect to PostgreSQL:', e.message)
    process.exit(1)
  }

  // ──── Create schema in PG ────
  if (!DRY_RUN) {
    console.log()
    console.log('📋 Creating schema in PostgreSQL...')
    try {
      const initSql = readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', '001_init.sql'), 'utf-8')
      await pool.query(initSql)
      console.log('✅ Schema created')
    } catch (e) {
      console.error('❌ Schema creation failed:', e.message)
      // Continue — tables might already exist
    }
  }

  // ──── Migrate data ────
  console.log()
  console.log('📦 Migrating data...')
  console.log('─'.repeat(50))

  const counts = {}

  for (const table of TABLES) {
    // Read from SQLite
    let rows
    try {
      rows = sqlite.prepare(`SELECT * FROM ${table}`).all()
    } catch (e) {
      console.log(`  ⏭️  ${table}: skipped (table not found or empty)`)
      counts[table] = { sqlite: 0, pg: 0, migrated: 0, error: e.message }
      continue
    }

    const sqliteCount = rows.length
    counts[table] = { sqlite: sqliteCount, pg: 0, migrated: 0 }

    if (sqliteCount === 0) {
      console.log(`  ⏭️  ${table}: 0 rows — skipped`)
      continue
    }

    if (DRY_RUN) {
      console.log(`  📋 ${table}: ${sqliteCount} rows (dry run)`)
      counts[table].migrated = sqliteCount
      continue
    }

    // Get columns from first row
    const columns = Object.keys(rows[0])
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
    const colNames = columns.join(', ')
    const insertSql = `INSERT INTO ${table} (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`

    let migrated = 0
    let errors = 0

    for (const row of rows) {
      const values = columns.map(col => {
        const val = row[col]
        // Convert undefined to null
        return val === undefined ? null : val
      })

      try {
        const result = await pool.query(insertSql, values)
        if (result.rowCount > 0) migrated++
      } catch (e) {
        errors++
        if (errors <= 3) {
          console.warn(`    ⚠️  Row error in ${table}:`, e.message.slice(0, 100))
        }
      }
    }

    counts[table].migrated = migrated
    counts[table].errors = errors

    const icon = errors > 0 ? '⚠️' : '✅'
    console.log(`  ${icon} ${table}: ${migrated}/${sqliteCount} migrated${errors > 0 ? ` (${errors} errors)` : ''}`)
  }

  // ──── Verify ────
  console.log()
  console.log('─'.repeat(50))
  console.log('🔍 Verifying row counts in PostgreSQL...')

  for (const table of TABLES) {
    try {
      const result = await pool.query(`SELECT COUNT(*) as c FROM ${table}`)
      const pgCount = parseInt(result.rows[0]?.c || 0)
      counts[table].pg = pgCount

      const sqliteCount = counts[table].sqlite
      const match = pgCount >= sqliteCount ? '✅' : '⚠️'
      console.log(`  ${match} ${table}: PG=${pgCount}, SQLite=${sqliteCount}`)
    } catch (e) {
      console.log(`  ❌ ${table}: verification failed — ${e.message.slice(0, 80)}`)
    }
  }

  // ──── Summary ────
  console.log()
  console.log('═══════════════════════════════════════')
  console.log('  MIGRATION SUMMARY')
  console.log('═══════════════════════════════════════')

  let totalMigrated = 0
  let totalErrors = 0
  for (const [table, data] of Object.entries(counts)) {
    totalMigrated += data.migrated || 0
    totalErrors += data.errors || 0
    console.log(`  ${table.padEnd(25)} SQLite: ${String(data.sqlite).padStart(6)}  PG: ${String(data.pg).padStart(6)}  Migrated: ${String(data.migrated).padStart(6)}`)
  }

  console.log('─'.repeat(50))
  console.log(`  Total migrated: ${totalMigrated}`)
  console.log(`  Total errors:   ${totalErrors}`)
  console.log('═══════════════════════════════════════')

  if (DRY_RUN) {
    console.log()
    console.log('ℹ️  This was a dry run. Set DRY_RUN=false or remove it to perform actual migration.')
  }

  // ──── Cleanup ────
  sqlite.close()
  await pool.end()
  console.log()
  console.log('✅ Migration script complete')
}

migrate().catch(e => {
  console.error('❌ Migration failed:', e)
  process.exit(1)
})
