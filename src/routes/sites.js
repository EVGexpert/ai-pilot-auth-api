import { findSitesByUser, findSiteByUserAndUrl, findSiteById, createSite, deleteSite, allSites, updateSiteToken, getSiteMemory, setSiteMemory, formatSiteMemory, createAuditEvent } from '../db.js'
import { verifyToken } from '../middleware/auth.js'
import { config } from '../config.js'
import { createHash } from 'crypto'

// ============================================================
// Хелперы
// ============================================================

/** fetch с таймаутом */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function authGuard(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' })
  const payload = verifyToken(auth.slice(7))
  if (!payload) return reply.status(401).send({ error: 'Invalid token' })
  request.user = payload
  return null
}

function isAdmin(payload) {
  return payload?.role === 'admin'
}

/**
 * Нормализация и валидация URL сайта.
 * Возвращает { url, error }.
 * error — строка ошибки или null.
 */
function normalizeSiteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: null, error: 'URL обязателен' }
  }

  let url = rawUrl.trim().toLowerCase()

  // Убираем trailing slash
  url = url.replace(/\/+$/, '')

  // Проверяем протокол
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { url: null, error: 'URL должен начинаться с http:// или https://' }
  }

  try {
    const parsed = new URL(url)

    // В production: запрещаем localhost и private IP
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

/**
 * Простой per-IP rate limit для connect-code.
 * Хранит счётчики в Map (сбрасывается при рестарте — это нормально).
 */
const ipRateLimit = new Map()
const CONNECT_CODE_MAX = 5       // максимум попыток
const CONNECT_CODE_WINDOW = 60000  // за 1 минуту

function checkConnectCodeRateLimit(ip) {
  if (!ip) return true  // не блокируем если нет IP
  const now = Date.now()
  const entry = ipRateLimit.get(ip)
  if (!entry || now - entry.resetAt > CONNECT_CODE_WINDOW) {
    ipRateLimit.set(ip, { count: 1, resetAt: now + CONNECT_CODE_WINDOW })
    return true
  }
  entry.count++
  if (entry.count > CONNECT_CODE_MAX) return false
  return true
}

// Уведомить Gateway о новом сайте
async function notifyGateway(url, apiToken, userId) {
  const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:18789'
  const envToken = process.env.GATEWAY_TOKEN || process.env.VITE_GATEWAY_TOKEN || ''
  const gatewayToken = envToken === 'dev-gateway-token' ? 'f8186e8d77460feeb735a8dbc48e659c9b05c7f10b114fd554d6fd7a8f8e76e3' : envToken

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
      console.log('[Gateway] Site notification sent for:', url)
    } else {
      const text = await resp.text()
      console.warn('[Gateway] Notification failed:', resp.status, text.slice(0, 200))
    }
  } catch (err) {
    console.warn('[Gateway] Notification error:', err.message)
  }
}

// ============================================================
// Routes
// ============================================================

export default async function sitesRoutes(app) {

  // ==========================================================
  // Подключить сайт через одноразовый code
  // ==========================================================
  app.post('/connect-code', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { code, siteUrl } = request.body || {}
    if (!code || !siteUrl) {
      return reply.status(400).send({ error: 'code_required', message: 'Code and siteUrl required' })
    }

    // Rate limit по IP
    const ip = request.ip
    if (!checkConnectCodeRateLimit(ip)) {
      createAuditEvent({
        userId: request.user.sub, eventType: 'connect_code_rate_limited',
        payload: { reason: 'ip_rate_limit', ip }, ipAddress: ip,
        requestId: request.requestId, status: '429'
      })
      return reply.status(429).send({ error: 'too_many_attempts', message: 'Слишком много попыток. Попробуйте через минуту.' })
    }

    // Нормализация URL
    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(siteUrl)
    if (urlError) {
      return reply.status(400).send({ error: 'invalid_url', message: urlError })
    }

    let existingSite = findSiteByUserAndUrl(request.user.sub, cleanUrl)

    try {
      const verifyUrl = `${cleanUrl}/wp-json/aipilot/v1/agent/verify-code?code=${encodeURIComponent(code)}`
      const resp = await fetchWithTimeout(verifyUrl, {}, 10000)

      if (resp.status === 404 || resp.status === 400) {
        // WP plugin не отвечает или code недействителен
        const body = await resp.text().catch(() => '')
        const isPluginMissing = body.includes('rest_no_route') || body.includes('not_found')

        createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: isPluginMissing ? 'wp_plugin_not_found' : 'code_invalid', siteUrl: cleanUrl },
          ipAddress: ip, requestId: request.requestId, status: String(resp.status)
        })

        if (isPluginMissing) {
          return reply.status(404).send({ error: 'wp_plugin_not_found',
            message: 'Плагин AI Pilot не найден на сайте. Установите и активируйте его.' })
        }
        return reply.status(404).send({ error: 'code_invalid',
          message: 'Код недействителен или истёк. Сгенерируйте новый в плагине.' })
      }

      if (!resp.ok) {
        createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: 'site_unreachable', siteUrl: cleanUrl, status: resp.status },
          ipAddress: ip, requestId: request.requestId, status: String(resp.status)
        })
        return reply.status(502).send({ error: 'site_unreachable',
          message: `Сайт не отвечает (HTTP ${resp.status}). Проверьте, что сайт доступен.` })
      }

      const data = await resp.json()
      if (!data.verified) {
        createAuditEvent({
          userId: request.user.sub, eventType: 'connect_code_failed',
          payload: { reason: 'code_invalid_response', siteUrl: cleanUrl },
          ipAddress: ip, requestId: request.requestId, status: '422'
        })
        return reply.status(422).send({ error: 'code_invalid',
          message: 'Код недействителен или истёк. Сгенерируйте новый в плагине.' })
      }

      const siteName = data.site_name || cleanUrl
      const apiToken = data.token || ''

      if (existingSite) {
        updateSiteToken(existingSite.id, apiToken)
        if (apiToken) {
          notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
        }
        return reply.send({ id: existingSite.id, url: cleanUrl, name: siteName, verified: !!apiToken })
      }

      const site = createSite({
        userId: request.user.sub, url: cleanUrl, name: siteName, apiToken,
        wpVersion: null, verified: apiToken ? 1 : 0
      })

      if (apiToken) {
        notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
      }

      createAuditEvent({
        userId: request.user.sub, siteId: site.id, eventType: 'site_connected',
        payload: { method: 'connect_code', siteUrl: cleanUrl },
        ipAddress: ip, requestId: request.requestId, status: '201'
      })

      return reply.status(201).send({ id: site.id, url: cleanUrl, name: siteName, verified: !!apiToken })
    } catch (e) {
      createAuditEvent({
        userId: request.user.sub, eventType: 'connect_code_error',
        payload: { reason: 'network_error', siteUrl: cleanUrl, error: e.message },
        ipAddress: ip, requestId: request.requestId, status: '502'
      })
      return reply.status(502).send({ error: 'site_unreachable',
        message: `Не удалось подключиться к сайту: ${e.message}` })
    }
  })

  // ==========================================================
  // Подключить сайт (с API токеном)
  // ==========================================================
  app.post('/connect', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { url, apiToken, name } = request.body || {}
    if (!url || !apiToken) return reply.status(400).send({ error: 'URL сайта и API токен обязательны' })

    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(url)
    if (urlError) return reply.status(400).send({ error: 'invalid_url', message: urlError })

    if (findSiteByUserAndUrl(request.user.sub, cleanUrl)) {
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
      console.error('Site verification failed:', err.message)
    }

    const site = createSite({
      userId: request.user.sub, url: cleanUrl, name: siteName, apiToken,
      wpVersion, verified: wpVersion ? 1 : 0
    })

    if (apiToken && apiToken !== 'pending') {
      notifyGateway(cleanUrl, apiToken, request.user.sub).catch(() => {})
    }

    return reply.status(201).send({ id: site.id, url: cleanUrl, name: siteName, wpVersion, verified: !!wpVersion })
  })

  // ==========================================================
  // Список сайтов
  // ==========================================================
  app.get('/', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    let siteList
    if (isAdmin(request.user)) {
      const seen = new Set()
      siteList = allSites().filter(s => {
        if (seen.has(s.url)) return false
        seen.add(s.url)
        return true
      }).map(s => ({
        id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, verified: s.verified, created_at: s.created_at
      }))
    } else {
      siteList = findSitesByUser(request.user.sub).map(s => ({
        id: s.id, url: s.url, name: s.name, wp_version: s.wp_version, verified: s.verified, created_at: s.created_at
      }))
    }
    return reply.send({ sites: siteList })
  })

  // ==========================================================
  // Информация о сайте
  // ==========================================================
  app.get('/:id', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err
    const site = findSiteById(request.params.id)
    if (!site || site.user_id !== request.user.sub) return reply.status(404).send({ error: 'Site not found' })
    return reply.send({ site })
  })

  // ==========================================================
  // Сканировать сайт
  // ==========================================================
  app.post('/scan', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { url, apiToken } = request.body || {}
    if (!url) return reply.status(400).send({ error: 'URL сайта обязателен' })

    const { url: cleanUrl, error: urlError } = normalizeSiteUrl(url)
    if (urlError) return reply.status(400).send({ error: 'invalid_url', message: urlError })

    let token = apiToken
    if (!token || token === 'pending') {
      const site = findSiteByUserAndUrl(request.user.sub, cleanUrl)
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
        const found = findSiteByUserAndUrl(request.user.sub, cleanUrl)
        if (found && (!found.api_token || found.api_token === 'pending')) {
          updateSiteToken(found.id, apiToken)
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
  app.get('/:id/memory', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const site = findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request.user) && site.user_id !== request.user.sub) {
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
  app.post('/:id/memory', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const site = findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request.user) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }

    const { key, value, source } = request.body || {}
    if (!key || value === undefined) {
      return reply.status(400).send({ error: 'key и value обязательны' })
    }

    const result = setSiteMemory(site.id, key, String(value).slice(0, 2000), source || 'client')
    return reply.send({ status: 'saved', key, value: result.value, source: result.source })
  })

  // ==========================================================
  // Чтение локальной памяти сайта
  // ==========================================================
  app.get('/:id/memory-local', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err
    const site = findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request.user) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }
    const memory = getSiteMemory(site.id)
    return reply.send({ memory })
  })

  // ==========================================================
  // Обновить токен сайта
  // ==========================================================
  app.patch('/:id/token', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err
    const { apiToken } = request.body || {}
    if (!apiToken) return reply.status(400).send({ error: 'apiToken обязателен' })
    const site = findSiteById(request.params.id)
    if (!site) return reply.status(404).send({ error: 'Site not found' })
    if (!isAdmin(request.user) && site.user_id !== request.user.sub) {
      return reply.status(403).send({ error: 'Access denied' })
    }
    updateSiteToken(request.params.id, apiToken)
    return reply.send({ message: 'Токен обновлён', apiToken })
  })

  // ==========================================================
  // Удалить сайт
  // ==========================================================
  app.delete('/:id', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err
    const site = findSiteById(request.params.id)
    if (!site || site.user_id !== request.user.sub) return reply.status(404).send({ error: 'Site not found' })
    deleteSite(request.params.id)
    return reply.send({ message: 'Сайт удалён' })
  })
}
