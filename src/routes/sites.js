import { findSitesByUser, findSiteByUserAndUrl, findSiteById, createSite, deleteSite, allSites, updateSiteToken, getSiteMemory, setSiteMemory, formatSiteMemory, createAuditEvent, setCachedProfile } from '../db.js'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'
import { fetchWithTimeout } from '../utils/fetch.js'

const log = createLogger('sites')

// ============================================================
// Хелперы
// ============================================================

function isAdmin(request) {
  return request.user?.role === 'admin'
}

/**
 * Нормализация и валидация URL сайта.
 */
function normalizeSiteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: null, error: 'URL обязателен' }
  }

  let url = rawUrl.trim().toLowerCase()
  url = url.replace(/\/+$/, '')

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { url: null, error: 'URL должен начинаться с http:// или https://' }
  }

  try {
    const parsed = new URL(url)

    if (config.isProduction) {
      const hostname = parsed.hostname
      const privatePatterns = [
        'localhost', '127.0.0.1', '::1', '0.0.0.0',
        '10.', '172.16.', '172.17.', '172.18.', '172.19.',
        '172.20.', '172.21.', '172.22.', '172.23.',
        '172.24.', '172.25.', '172.26.', '172.27.',
        '172.28.', '172.29.', '172.30.', '172.31.',
        '192.168.'
      ]
      for (const p of privatePatterns) {
        if (hostname.startsWith(p)) {
          return { url: null, error: 'Нельзя подключать локальные/частные сайты в production' }
        }
      }
    }

    return { url, error: null }
  } catch (e) {
    return { url: null, error: 'Некорректный URL' }
  }
}

async function notifyGateway(url, apiToken, userId) {
  const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:18789'
  const envToken = process.env.GATEWAY_TOKEN || process.env.VITE_GATEWAY_TOKEN || ''
  const gatewayToken = envToken || ''

  try {
    const resp = await fetchWithTimeout(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: `[system:new-site] url=${url}, userId=${userId}` }],
        max_tokens: 100
      })
    }, 5000)

    if (resp.ok) {
      log.info({ event: 'gateway_notification_sent', url }, 'Site notification sent')
    } else {
      const text = await resp.text()
      log.warn({ event: 'gateway_notification_failed', status: resp.status, detail: text.slice(0, 200) }, 'Notification failed')
    }
  } catch (err) {
    log.warn({ event: 'gateway_notification_error', err: err.message }, 'Notification error')
  }
}

/**
 * Запросить capability profile с сайта и закэшировать его (Mode Router).
 * Fallback: 404/5xx/таймаут/мусор = старый плагин, работаем как раньше.
 * Fire-and-forget — не блокирует connect.
 */
async function fetchAndCacheCapabilities(siteId, siteUrl, apiToken) {
  if (!apiToken || apiToken === 'pending') return
  const base = siteUrl.replace(/\/+$/, '')
  try {
    const resp = await fetchWithTimeout(
      base + '/wp-json/aipilot/v1/agent/capabilities',
      { headers: { 'X-AI-Pilot-Token': apiToken } },
      5000
    )
    if (!resp.ok) {
      log.info({ event: 'capabilities_not_available', siteId, status: resp.status }, 'Capability endpoint not available (fallback)')
      return
    }
    const profile = await resp.json()
    if (profile && typeof profile === 'object') {
      await setCachedProfile(siteId, profile)
      log.info({ event: 'capabilities_cached', siteId, mode: profile.authoring_mode || profile.mode || null }, 'Capability profile cached')
    }
  } catch (err) {
    log.warn({ event: 'capabilities_fetch_error', siteId, err: err.message }, 'Capability fetch failed (fallback)')
  }
}

// ============================================================
// Routes
// ============================================================

export default async function sitesRoutes(app) {

  // ==========================================================
  // Подключить сайт через одноразовый code
  // ==========================================================
  app.post('/connect-code', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { code, siteUrl } = request.body || {}
    if (!code || !siteUrl) {
      return reply.status(400).send({ error: 'code_required', message: 'Code and siteUrl required' })
    }

    const ip = request.ip

    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(siteUrl)
    if (urlError) {
      return reply.status(400).send({ error: 'invalid_url', message: urlError })
    }

    let existingSite = await findSiteByUserAndUrl(request.user.sub, cleanUrl)

    try {
      const verifyUrl = `${cleanUrl}/wp-json/aipilot/v1/agent/verify-code?code=${encodeURIComponent(code)}`
      const resp = await fetchWithTimeout(verifyUrl, {}, 10000)

      if (resp.status === 404 || resp.status === 400) {
        const body = await resp.text().catch(() => '')
        const isPluginMissing = body.includes('rest_no_route') || body.includes('not_found')

        await createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: isPluginMissing ? 'wp_plugin_not_found' : 'code_invalid', siteUrl: cleanUrl },
          ipAddress: ip, requestId: request.requestId, traceId: request.traceId, status: String(resp.status)
        })

        if (isPluginMissing) {
          return reply.status(404).send({ error: 'wp_plugin_not_found',
            message: 'Плагин AI Pilot не найден на сайте. Установите и активируйте его.' })
        }
        return reply.status(404).send({ error: 'code_invalid',
          message: 'Код недействителен или истёк. Сгенерируйте новый в плагине.' })
      }

      if (!resp.ok) {
        await createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: 'site_unreachable', siteUrl: cleanUrl, status: resp.status },
          ipAddress: ip, requestId: request.requestId, traceId: request.traceId, status: String(resp.status)
        })
        return reply.status(502).send({ error: 'site_unreachable',
          message: `Сайт не отвечает (HTTP ${resp.status}). Проверьте, что сайт доступен.` })
      }

      const data = await resp.json()
      if (!data.verified) {
        await createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: 'code_invalid_response', siteUrl: cleanUrl },
          ipAddress: ip, requestId: request.requestId, traceId: request.traceId, status: '422'
        })
        return reply.status(422).send({ error: 'code_invalid',
          message: 'Код недействителен или истёк. Сгенерируйте новый в плагине.' })
      }

      const siteName = data.site_name || cleanUrl
      const apiToken = data.token || ''

      if (existingSite) {
        await updateSiteToken(existingSite.id, apiToken)
        if (apiToken) {
          notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
          fetchAndCacheCapabilities(existingSite.id, cleanUrl, apiToken).catch(() => {})
        }
        return reply.send({ id: existingSite.id, url: cleanUrl, name: siteName, verified: !!apiToken })
      }

      const site = await createSite({
        userId: request.user.sub, url: cleanUrl, name: siteName, apiToken,
        wpVersion: null, verified: apiToken ? 1 : 0
      })

      if (apiToken) {
        notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
        fetchAndCacheCapabilities(site.id, cleanUrl, apiToken).catch(() => {})
      }

      await createAuditEvent({
        userId: request.user.sub, siteId: site.id, eventType: 'site_connected',
        payload: { method: 'connect_code', siteUrl: cleanUrl },
        ipAddress: ip, requestId: request.requestId, traceId: request.traceId, status: '201'
      })

      return reply.status(201).send({ id: site.id, url: cleanUrl, name: siteName, verified: !!apiToken })
    } catch (e) {
      await createAuditEvent({
        userId: request.user.sub, eventType: 'connect_code_error',
        payload: { reason: 'network_error', siteUrl: cleanUrl, error: e.message },
        ipAddress: ip, requestId: request.requestId, traceId: request.traceId, status: '502'
      })
      return reply.status(502).send({ error: 'site_unreachable',
        message: `Не удалось подключиться к сайту: ${e.message}` })
    }
  })

  // ==========================================================
  // Подключить сайт (с API токеном)
  // ==========================================================
  app.post('/connect', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { url, apiToken, name } = request.body || {}
    if (!url || !apiToken) return reply.status(400).send({ error: 'URL сайта и API токен обязательны' })

    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(url)
    if (urlError) return reply.status(400).send({ error: 'invalid_url', message: urlError })

    if (await findSiteByUserAndUrl(request.user.sub, cleanUrl)) {
      return reply.status(409).send({ error: 'Сайт уже привязан к вашему аккаунту' })
    }

    let siteName = name || cleanUrl
    let wpVersion = null
    try {
      const resp = await fetchWithTimeout(`${cleanUrl}/wp-json/aipilot/v1/site`, {
        headers: { 'X-AI-Pilot-Token': apiToken }
      }, 10000)
      if (resp.ok) {
        const data = await resp.json()
        siteName = data.name || siteName
        wpVersion = data.wp_version
      }
    } catch (err) {
      log.error({ event: 'site_verification_failed', err: err.message }, 'Site verification failed')
    }

    const site = await createSite({
      userId: request.user.sub, url: cleanUrl, name: siteName, apiToken,
      wpVersion, verified: wpVersion ? 1 : 0
    })

    if (apiToken && apiToken !== 'pending') {
      notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
      fetchAndCacheCapabilities(site.id, cleanUrl, apiToken).catch(() => {})
    }

    return reply.status(201).send({ id: site.id, url: cleanUrl, name: siteName, wpVersion, verified: !!wpVersion })
  })

  // ==========================================================
  // Список сайтов
  // ==========================================================
  app.get('/', { preHandler: [authMiddleware] }, async (request, reply) => {
    let siteList
    if (isAdmin(request)) {
      const seen = new Set()
      siteList = (await allSites()).filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      }).map(s => ({
        id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, verified: s.verified, created_at: s.created_at
      }))
    } else {
      siteList = (await findSitesByUser(request.user.sub)).map(s => ({
        id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, verified: s.verified, created_at: s.created_at
      }))
    }
    return reply.send({ sites: siteList })
  })

  // ==========================================================
  // Информация о сайте
  // ==========================================================
  app.get('/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const site = await findSiteById(request.params.id)
    if (!site || site.user_id !== request.user.sub) return reply.status(404).send({ error: 'Site not found' })
    return reply.send({ site })
  })

  // ==========================================================
  // Сканировать сайт
  // ==========================================================
  app.post('/scan', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { url, apiToken } = request.body || {}
    if (!url) return reply.status(400).send({ error: 'URL сайта обязателен' })

    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(url)
    if (urlError) return reply.status(400).send({ error: 'invalid_url', message: urlError })

    let token = apiToken
    if (!token || token === 'pending') {
      const site = await findSiteByUserAndUrl(request.user.sub, cleanUrl)
      if (site && site.api_token && site.api_token !== 'pending') {
        token = site.api_token
      }
    }

    if (!token || token === 'pending') {
      return reply.status(400).send({ error: 'API токен не найден. Сгенерируйте токен в AI Pilot → Настройки' })
    }

    try {
      const scanUrl = `${cleanUrl}/wp-json/aipilot/v1/agent/scan`
      const resp = await fetchWithTimeout(scanUrl, {
        method: 'GET',
        headers: { 'X-AI-Pilot-Token': token }
      }, 10000)

      if (!resp.ok) {
        const text = await resp.text()
        return reply.status(resp.status).send({ error: 'Scan failed', detail: text.slice(0, 500) })
      }

      const data = await resp.json()

      if (apiToken && apiToken !== 'pending') {
        const found = await findSiteByUserAndUrl(request.user.sub, cleanUrl)
        if (found && (!found.api_token || found.api_token === 'pending')) {
          await updateSiteToken(found.id, apiToken)
          notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
        }
      }

      return reply.send({ scanned: true, scanned_at: data.scanned_at, structure: data.structure })
    } catch (e) {
      return reply.status(502).send({ error: `Scan request failed: ${e.message}` })
    }
  })

  // ==========================================================
  // История обращений (с сайта через WP REST API)
  // ==========================================================
  app.get('/:id/memory', { preHandler: [authMiddleware] }, async (request, reply) => {
    const site = await findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }

    if (!site.api_token || site.api_token === 'pending') {
      return reply.send({ memory: [], total: 0, scanned_at: null })
    }

    try {
      const url = site.url.replace(/\/+$/, '')
      const resp = await fetchWithTimeout(`${url}/wp-json/aipilot/v1/agent/memory`, {
        headers: { 'X-AI-Pilot-Token': site.api_token }
      }, 10000)
      if (resp.ok) {
        return reply.send(await resp.json())
      }
      return reply.send({ memory: [], total: 0 })
    } catch (e) {
      return reply.send({ memory: [], total: 0, error: e.message })
    }
  })

  // ==========================================================
  // Запись в локальную память сайта
  // ==========================================================
  app.post('/:id/memory', { preHandler: [authMiddleware] }, async (request, reply) => {
    const site = await findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }

    const { key, value, source } = request.body || {}
    if (!key || value === undefined) {
      return reply.status(400).send({ error: 'key и value обязательны' })
    }

    const result = await setSiteMemory(site.id, key, String(value).slice(0, 2000), source || 'client')
    return reply.send({ status: 'saved', key, source: source || 'client' })
  })

  // ==========================================================
  // Чтение локальной памяти сайта
  // ==========================================================
  app.get('/:id/memory-local', { preHandler: [authMiddleware] }, async (request, reply) => {
    const site = await findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }
    const memory = await getSiteMemory(site.id)
    return reply.send({ memory })
  })

  // ==========================================================
  // Обновить токен сайта
  // ==========================================================
  app.patch('/:id/token', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { apiToken } = request.body || {}
    if (!apiToken) return reply.status(400).send({ error: 'apiToken обязателен' })
    const site = await findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }
    await updateSiteToken(request.params.id, apiToken)
    return reply.send({ message: 'Токен обновлён', apiToken })
  })

  // ==========================================================
  // Удалить сайт
  // ==========================================================
  app.delete('/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const site = await findSiteById(request.params.id)
    if (!site || site.user_id !== request.user.sub) return reply.status(404).send({ error: 'Site not found' })
    await deleteSite(request.params.id)
    return reply.send({ message: 'Сайт удалён' })
  })
}
