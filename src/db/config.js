import { queryOne, run, now } from './connection.js'

export async function getConfigValue(key) {
  const row = await queryOne('SELECT value FROM config WHERE key = ?', [key])
  return row?.value || null
}

export async function setConfigValue(key, value) {
  const t = now()
  await run(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value, t])
}
