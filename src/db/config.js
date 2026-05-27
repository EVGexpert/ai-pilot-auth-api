import { queryOne, run } from './connection.js'

export function getConfigValue(key) {
  const row = queryOne('SELECT value FROM config WHERE key = ?', [key])
  return row?.value || null
}

export function setConfigValue(key, value) {
  run(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value])
}
