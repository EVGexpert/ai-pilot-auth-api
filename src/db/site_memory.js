import { queryOne, queryAll, run, uid, now } from './connection.js'

export async function getSiteMemory(siteId) {
  return await queryAll('SELECT * FROM site_memory WHERE site_id = ? ORDER BY updated_at DESC', [siteId])
}
export async function getSiteMemoryByKey(siteId, key) {
  return await queryOne('SELECT * FROM site_memory WHERE site_id = ? AND key = ?', [siteId, key])
}
export async function setSiteMemory(siteId, key, value, source = 'agent') {
  await run(`INSERT INTO site_memory (id, site_id, key, value, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
    [uid(), siteId, key, value, source, now()])
}
export async function deleteSiteMemory(siteId, key) {
  await run('DELETE FROM site_memory WHERE site_id = ? AND key = ?', [siteId, key])
}
export async function formatSiteMemory(siteId) {
  const rows = await getSiteMemory(siteId)
  if (rows.length === 0) return ''
  return rows.map(r => `- ${r.key}: ${r.value.slice(0, 200)}`).join('\n')
}
