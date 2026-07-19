import { queryOne, run, now } from './connection.js'

/**
 * Capability Cache — хранение capability profile сайта и authoring mode.
 *
 * Колонка sites.cached_capabilities (TEXT) хранит JSON:
 *   { profile: <raw capability profile>, cached_at: <ISO timestamp> }
 *
 * Timestamp встроен в JSON, чтобы не конфликтовать с sites.cached_at
 * (который относится к cached_structure / cached_soul).
 *
 * AP-011: кэш временный, TTL по умолчанию 1 час.
 */

const DEFAULT_TTL_MS = 3600 * 1000

/**
 * Извлечь authoring mode из raw profile объекта.
 * Поддерживает несколько возможных имён поля (спецификация endpoint гибкая).
 */
function extractMode(profile) {
  if (!profile || typeof profile !== 'object') return null
  const mode = profile.authoring_mode || profile.mode || profile.authoringMode
  return mode ? String(mode) : null
}

/**
 * Распарсить сырую JSON-строку из sites.cached_capabilities.
 * Чистая функция — для уже загруженной строки (без доп. запроса к БД).
 * Возвращает { profile, cached_at, mode } | null.
 */
export function parseProfile(rawJson) {
  if (!rawJson) return null
  try {
    const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
    if (!parsed || typeof parsed !== 'object') return null
    // Поддержка обёртки { profile, cached_at } и raw profile
    if (parsed.profile && typeof parsed.profile === 'object') {
      return { profile: parsed.profile, cached_at: parsed.cached_at || null, mode: extractMode(parsed.profile) }
    }
    return { profile: parsed, cached_at: null, mode: extractMode(parsed) }
  } catch (e) {
    return null
  }
}

/**
 * Получить сохранённый capability profile для сайта.
 * Возвращает { profile, cached_at, mode } | null.
 */
export async function getCachedProfile(siteId) {
  const row = await queryOne('SELECT cached_capabilities FROM sites WHERE id = ?', [siteId])
  return parseProfile(row?.cached_capabilities)
}

/**
 * Сохранить capability profile в БД (с timestamp).
 */
export async function setCachedProfile(siteId, profile) {
  const payload = JSON.stringify({ profile, cached_at: new Date().toISOString() })
  await run('UPDATE sites SET cached_capabilities = ?, updated_at = ? WHERE id = ?', [payload, now(), siteId])
  return parseProfile(payload)
}

/**
 * Проверить freshness закэшированного profile.
 * Возвращает false если профиля нет или он старше ttlMs.
 */
export async function isProfileFresh(siteId, ttlMs = DEFAULT_TTL_MS) {
  const entry = await getCachedProfile(siteId)
  if (!entry || !entry.cached_at) return false
  const age = Date.now() - new Date(entry.cached_at).getTime()
  return age >= 0 && age < ttlMs
}

/**
 * Получить authoring mode сайта из кэша.
 * Возвращает строку режима | null (нет профиля).
 */
export async function getAuthoringMode(siteId) {
  const entry = await getCachedProfile(siteId)
  return entry?.mode || null
}

export const CAPABILITY_TTL_MS = DEFAULT_TTL_MS
