import { queryOne, queryAll, run, uid, now } from './connection.js'

export function findSitesByUser(userId) {
  return queryAll('SELECT * FROM sites WHERE user_id = ?', [userId])
}
export function findSiteByUserAndUrl(userId, url) {
  return queryOne('SELECT * FROM sites WHERE user_id = ? AND url = ?', [userId, url])
}
export function findSiteById(id) {
  return queryOne('SELECT * FROM sites WHERE id = ?', [id])
}
export function createSite({ userId, url, name, apiToken, wpVersion, verified = 0 }) {
  const id = uid()
  const t = now()
  run('INSERT INTO sites (id, user_id, url, name, api_token, wp_version, verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, userId, url, name || null, apiToken || null, wpVersion || null, verified, t, t])
  return findSiteById(id)
}
export function updateSiteCache(id, fields) {
  const struct = fields.cached_structure ? (typeof fields.cached_structure === 'string' ? fields.cached_structure : JSON.stringify(fields.cached_structure)) : null
  const soul = fields.cached_soul ? (typeof fields.cached_soul === 'string' ? fields.cached_soul : JSON.stringify(fields.cached_soul)) : null
  run('UPDATE sites SET cached_structure = COALESCE(?, cached_structure), cached_soul = COALESCE(?, cached_soul), cached_at = COALESCE(?, cached_at), updated_at = ? WHERE id = ?',
    [struct, soul, fields.cached_at || null, now(), id])
  return findSiteById(id)
}
export function updateSiteToken(id, token) {
  run('UPDATE sites SET api_token = ?, verified = 1, updated_at = ? WHERE id = ?', [token, now(), id])
  return findSiteById(id)
}
export function deleteSite(id) {
  run('DELETE FROM sites WHERE id = ?', [id])
  return true
}
export function allSites() {
  return queryAll('SELECT * FROM sites ORDER BY created_at DESC')
}
