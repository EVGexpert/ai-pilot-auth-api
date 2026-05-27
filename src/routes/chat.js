import { findSitesByUser, findSiteByUserAndUrl, findSiteById, updateSiteCache, findOrCreateSession, findSessionById, findSessionsByUserAndSite, createChatSession, createMessage, updateMessageStatus, getMessagesBySession, createJob, createAuditEvent, registerJobHandler, getConfigValue, updateSessionSummary, formatSiteMemory, setSiteMemory } from '../db.js'
import { verifyToken } from '../middleware/auth.js'
import { CORE_RULES, GREETING_INSTRUCTION } from '../config/prompt.js'

// Регистрируем обработчики для фоновых задач
registerJobHandler('refresh_context', async (job) => {
  const { siteUrl, apiToken } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  const ctxRes = await fetch(
    siteUrl.replace(/\/+$/, '') + '/wp-json/aipilot/v1/agent/context',
    { headers: { 'X-AI-Pilot-Token': apiToken }, signal: controller.signal }
  )
  clearTimeout(timeout)
  if (ctxRes.ok) {
    const ctx = await ctxRes.json()
    const site = findSiteByUserAndUrl(job.user_id, siteUrl)
    if (site) {
      updateSiteCache(site.id, {
        cached_structure: JSON.stringify(ctx.structure || ctx),
        cached_soul: JSON.stringify(ctx.soul || {}),
        cached_at: new Date().toISOString()
      })
    }
  }
})

registerJobHandler('sync_wp_memory', async (job) => {
  const { siteUrl, apiToken, message, response, agentId } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const memoryUrl = siteUrl.replace(/\/+$/, '') + '/wp-json/aipilot/v1/agent/memory'
  const resp = await fetch(memoryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AI-Pilot-Token': apiToken },
    body: JSON.stringify({
      action: 'client_message', summary: message.slice(0, 200),
      details: { response: (response || '').slice(0, 500), agentId }, agent: 'client'
    })
  })
  if (!resp.ok) throw new Error('WP memory sync: ' + resp.status)
})

function authGuard(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' })
  const payload = verifyToken(auth.slice(7))
  if (!payload) return reply.status(401).send({ error: 'Invalid token' })
  request.user = payload
  return null
}

function getAgentId(url) {
  const hostname = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase()
  return `site-${hostname}`
}

function buildSystemPrompt(site, siteUrl, message, contextSummary) {
  const isGreeting = message.trim() === '/start'
  const greetingBlock = isGreeting ? `\n\n${GREETING_INSTRUCTION}` : ''
  return `Ты AI-помощник для сайта ${site.name || siteUrl}.${contextSummary}\n\nПравила:\n${CORE_RULES}\n${greetingBlock}`
}

/**
 * JSON Schema для валидации структурированного действия от модели.
 */
const ACTION_SCHEMA = {
  type: 'object',
  required: ['type', 'target', 'patch'],
  properties: {
    type: { type: 'string', enum: ['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'] },
    target: { type: 'object', properties: { title: { type: 'string' }, id: { type: ['number', 'string'] }, slug: { type: 'string' } } },
    patch: { type: 'object' },
    requires_approval: { type: 'boolean', default: true }
  }
}

const ACTION_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['answer', 'actions'],
  properties: {
    answer: { type: 'string' },
    actions: {
      type: 'array',
      items: ACTION_SCHEMA
    }
  }
}

/**
 * Простая валидация JSON по схеме.
 */
function validateActionJson(data) {
  if (!data || typeof data !== 'object') return false
  if (!Array.isArray(data.actions) || data.actions.length === 0) return false
  for (const action of data.actions) {
    if (!action.type || !action.target) return false
    if (!['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'].includes(action.type)) return false
  }
  return true
}

/**
 * Парсит структурированный JSON из ответа модели.
 * Ищет блок ```action ...``` или ```json ...``` в ответе.
 */
function parseStructuredActions(content) {
  // Пробуем найти блок ```action или ```json
  const blockMatch = content.match(/```(?:action|json)\s*([\s\S]*?)```/)
  if (!blockMatch) return null
  try {
    const data = JSON.parse(blockMatch[1])
    if (!validateActionJson(data)) return null
    return data
  } catch (e) {
    return null
  }
}

/**
 * Основная функция: парсит действия из ответа модели.
 * Сначала пробует структурированный JSON, затем эвристику.
 *
 * @param {string} content - ответ модели
 * @param {string} userMessage - исходный запрос пользователя
 * @returns {{ actions: Array|null, cleanContent: string }}
 */
function parseActions(content, userMessage) {
  // 1. Пробуем структурированный JSON
  const structured = parseStructuredActions(content)
  if (structured && validateActionJson(structured)) {
    // Убираем блок ``` из visible-текста
    const cleanContent = content.replace(/```(?:action|json)\s*[\s\S]*?```/g, '').trim()
    const actions = structured.actions.map(a => ({
      id: 'ap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      title: a.type.replace(/_/g, ' ') + (a.target?.title ? ': ' + a.target.title : ''),
      description: 'Тип: ' + a.type + (a.target?.slug ? ', цель: ' + a.target.slug : ''),
      diff: Object.entries(a.patch || {}).map(([k, v]) => '+ ' + k + ': ' + String(v).slice(0, 80)),
      status: 'pending',
      raw: { type: a.type, target: a.target, patch: a.patch }
    }))
    return { actions, cleanContent }
  }

  // 2. Fallback: эвристика (старая)
  const actionKeywords = [/созда(ть|м|й|ю|ём|ла|н|в)/i, /опублик(овать|уй|ую|уется|ю)/i, /обнов(ить|и|им|ляем|ля)/i, /добав(ить|им|лю|ляем|ля)/i, /удали(ть|м|ю)/i, /измен(ить|им|яю|яем|я)/i, /редактир(овать|уй)/i, /напис(ать|а|и|ем|у|ан)/i, /загру(зить|жу|зим|з)/i, /настро(ить|й|им|и)/i]
  const agreePhrases = [/предлагаю/i, /могу/i, /давай/i, /сделаю/i, /можно/i, /готов/i, /создам/i, /опубликую/i, /обновлю/i, /добавлю/i]
  
  const userWants = actionKeywords.some(r => r.test(userMessage))
  const modelAgrees = agreePhrases.some(r => r.test(content))
  if (!userWants || !modelAgrees) return null

  let title = 'Выполнить'
  if (/созда(ть|м|й)/i.test(userMessage)) title = 'Создать'
  if (/опублик(овать|уй)/i.test(userMessage)) title = 'Опубликовать'
  if (/обнов(ить|и)/i.test(userMessage)) title = 'Обновить'
  if (/добав(ить|лю)/i.test(userMessage)) title = 'Добавить'
  if (/удали(ть|м)/i.test(userMessage)) title = 'Удалить'
  
  const objMatch = userMessage.match(/(?:пост|страниц[уа]|раздел|рубрик[уа]|категори[юя]|меню|плагин|тем[уа]|настройк[иуа]|пользовател[ья]|комментари[йя])/i)
  if (objMatch) title += ' ' + objMatch[0].toLowerCase()
  
  const topicMatch = userMessage.match(/[«"]([^»"]+)[»"]|про\s+(.+?)(?:\s|$|,|\.)/i)
  if (topicMatch) { const t = topicMatch[1] || topicMatch[2]; title += ': ' + (t.length > 40 ? t.slice(0, 40) + '...' : t) }

  const diff = []
  for (const line of content.split('\n').filter(l => l.trim())) {
    const trimmed = line.trim()
    if (/^(привет|здравствуй|давай|ок|окей|хорошо|понял|отлично|добро|если|уточни|какой|для какого)/i.test(trimmed)) continue
    if (/[?؟]/.test(trimmed)) continue
    if (trimmed.length < 10 || trimmed.length > 150) continue
    const clean = trimmed.replace(/^[-–—•·*\s]+/, '').trim()
    if (clean.length < 10) continue
    if (/(не могу|отключен|нет доступа|недоступ|ошибк|не работ)/i.test(clean)) continue
    diff.push('+ ' + clean)
    if (diff.length >= 5) break
  }

  if (diff.length === 0) return null

  return {
    actions: [{
      id: 'ap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      title: title.slice(0, 60),
      description: content.slice(0, 200).replace(/\n/g, ' '),
      diff,
      status: 'pending'
    }],
    cleanContent: content
  }
}

export default async function chatRoutes(app) {

  // Промпт для AI Pilot — единый источник
  const FULL_PROMPT = `Ты AI-помощник для WordPress-сайта.\n\nПравила:\n${CORE_RULES}`

  app.get('/prompt', async (request, reply) => {
    return reply.send({ prompt: FULL_PROMPT, coreRules: CORE_RULES, version: '1.0.0' })
  })

  // Отправить сообщение от клиента к агенту сайта
  app.post('/send', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { message, siteUrl, sessionId } = request.body || {}
    if (!message || !siteUrl) {
      return reply.status(400).send({ error: 'message и siteUrl обязательны' })
    }

    // Проверяем, что сайт принадлежит пользователю
    const site = findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) {
      return reply.status(403).send({ error: 'Сайт не привязан к вашему аккаунту' })
    }

    // Проверяем API токен ДО любых запросов к WP
    if (!site.api_token || site.api_token === 'pending') {
      return reply.status(400).send({
        error: 'API токен не найден. Сгенерируйте токен в AI Pilot → Настройки на вашем сайте'
      })
    }

    // Создаём или используем указанную сессию
    let session
    if (sessionId) {
      const existingSession = findSessionById(sessionId)
      if (existingSession && existingSession.user_id === request.user.sub && existingSession.site_id === site.id) {
        session = existingSession
      } else {
        session = createChatSession({ userId: request.user.sub, siteId: site.id, title: 'Чат' })
      }
    } else {
      session = findOrCreateSession(request.user.sub, site.id)
    }

    // Контекст сайта — из кэша (без ожидания WP)
    let contextSummary = ''
    const cacheAge = site.cached_at ? (Date.now() - new Date(site.cached_at).getTime()) / 1000 : Infinity
    if (site.cached_structure && cacheAge < 3600) {
      try {
        const struct = typeof site.cached_structure === 'string' ? JSON.parse(site.cached_structure) : site.cached_structure
        if (struct?.site) {
          contextSummary = `\nКонтекст сайта (из кэша):\n- Название: ${struct.site.name || site.name}\n- Описание: ${struct.site.description || ''}\n- WP: ${struct.site.wp_version || ''}\n- Плагины: ${struct.plugins?.active || 0} активных\n- Посты: ${struct.content?.posts?.length || 0}\n- Страницы: ${struct.content?.pages?.length || 0}`
        }
      } catch (e) { /* кэш битый */ }
    }

    // Фоновое обновление кэша — через очередь
    if (!contextSummary) {
      createJob({
        type: 'refresh_context',
        siteId: site.id,
        userId: request.user.sub,
        payload: { siteUrl, apiToken: site.api_token },
        maxAttempts: 1
      })
    }

    // Добавляем память сайта в контекст
    const siteMemoryBlock = formatSiteMemory(site.id)
    const memoryContext = siteMemoryBlock ? `

Память о предыдущих решениях:
${siteMemoryBlock}` : ''

    // Собираем промпт
    const systemPrompt = buildSystemPrompt(site, siteUrl, message, contextSummary + memoryContext)

    // Сохраняем сообщение пользователя со статусом 'pending'
    const userMsg = createMessage({
      sessionId: session.id,
      role: 'user',
      content: message,
      metadata: { siteUrl },
      source: 'client',
      status: 'received'
    })

    const agentId = getAgentId(siteUrl)
    const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:18789'
    // Gateway token: сначала из БД, потом из env
    let gatewayToken = getConfigValue('gateway_token')
    if (!gatewayToken) {
      gatewayToken = process.env.GATEWAY_TOKEN || process.env.VITE_GATEWAY_TOKEN || ''
    }
    if (!gatewayToken || gatewayToken === 'dev-gateway-token') {
      return reply.status(500).send({ error: 'GATEWAY_TOKEN не настроен' })
    }

    try {
      const model = 'openclaw'
      const prefixedMessage = `[client:${siteUrl}] ${message}`
      
      // Загружаем историю сессии (последние 12 сообщений)
      const historyMessages = getMessagesBySession(session.id)
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content }))
      
      // Если есть summary сессии и история длинная — добавляем как контекст
      let summaryBlock = ''
      if (session.summary && historyMessages.length >= 8) {
        summaryBlock = `\n\nКонтекст сессии:\n${session.summary}`
      }
      
      const messages = [
        { role: 'system', content: systemPrompt + summaryBlock },
        ...historyMessages,
        { role: 'user', content: prefixedMessage }
      ]

      const body = JSON.stringify({ model, messages, user: siteUrl, max_tokens: 4096, stream: false })

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gatewayToken}` },
        signal: controller.signal,
        body
      })
      clearTimeout(timeout)

      if (!resp.ok) {
        const text = await resp.text()
        updateMessageStatus(userMsg.id, 'failed')
        return reply.status(resp.status).send({
          error: 'Gateway request failed',
          detail: text.slice(0, 500)
        })
      }

      const data = await resp.json()
      const rawContent = data.choices?.[0]?.message?.content || ''

      // Парсим действия из ответа модели (structured JSON или эвристика)
      const parsed = parseActions(rawContent, message)
      const actions = parsed?.actions || null
      const displayContent = parsed?.cleanContent || rawContent

      // Обновляем статус сообщения пользователя
      updateMessageStatus(userMsg.id, 'sent')

      // Сохраняем ответ ассистента
      const assistantMsg = createMessage({
        sessionId: session.id,
        role: 'assistant',
        content: displayContent,
        metadata: { agentId, model, actions: actions ? JSON.stringify(actions) : null },
        source: 'gateway',
        status: 'sent'
      })

      // Пишем в память WordPress через очередь
      if (message.trim() !== '/start') {
        createJob({
          type: 'sync_wp_memory',
          siteId: site.id,
          userId: request.user.sub,
          sessionId: session.id,
          payload: {
            siteUrl, apiToken: site.api_token,
            message, response: displayContent, agentId
          },
          maxAttempts: 3
        })
      }

      // Авто-обновление session summary (при длинных диалогах)
      updateSessionSummary(session.id)

      // Audit log для отправленного сообщения
      createAuditEvent({
        userId: request.user.sub, siteId: site.id, sessionId: session.id,
        eventType: 'chat_message', entityType: 'message', entityId: assistantMsg.id,
        payload: { role: 'assistant', hasActions: !!actions },
        status: 'sent'
      })

      return reply.send({
        message: displayContent,
        actions,
        agentId,
        siteUrl,
        sessionId: session.id,
        messageId: userMsg.id
      })
    } catch (e) {
      if (userMsg) updateMessageStatus(userMsg.id, 'failed')
      return reply.status(502).send({ error: `Chat proxy failed: ${e.message}` })
    }
  })

  // Список сессий с превью
  app.get('/sessions', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { siteUrl } = request.query
    if (!siteUrl) return reply.status(400).send({ error: 'siteUrl обязателен' })

    const site = findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })

    const sessions = findSessionsByUserAndSite(request.user.sub, site.id)
    const result = sessions.map(s => {
      const msgs = getMessagesBySession(s.id)
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null
      const userMsgs = msgs.filter(m => m.role === 'user')
      return {
        id: s.id,
        title: s.title || 'Чат',
        preview: lastMsg ? lastMsg.content.slice(0, 60) : '',
        date: s.created_at.slice(0, 10),
        messageCount: msgs.length,
        lastMessage: lastMsg ? { role: lastMsg.role, created_at: lastMsg.created_at } : null
      }
    })
    return reply.send({ sessions: result })
  })

  // Новая сессия
  app.post('/new', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { siteUrl } = request.body || {}
    if (!siteUrl) return reply.status(400).send({ error: 'siteUrl обязателен' })

    const site = findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })

    const session = createChatSession({ userId: request.user.sub, siteId: site.id, title: 'Чат' })
    return reply.send({ sessionId: session.id })
  })

  // История сообщений для сессии
  app.get('/history', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { siteUrl, sessionId } = request.query
    if (!siteUrl && !sessionId) {
      return reply.status(400).send({ error: 'Укажите siteUrl или sessionId' })
    }

    let sid = sessionId
    if (!sid && siteUrl) {
      const site = findSiteByUserAndUrl(request.user.sub, siteUrl)
      if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
      const sessions = findSessionsByUserAndSite(request.user.sub, site.id)
      if (sessions.length === 0) return reply.send({ messages: [], sessionId: null })
      sid = sessions[0].id
    }

    const messages = getMessagesBySession(sid)
    return reply.send({ messages, sessionId: sid })
  })

  /**
   * Выполнить действие через WordPress Plugin.
   * Создаёт proposal на WP и сразу его подтверждает.
   */
  async function executeWpAction(siteUrl, apiToken, action, actionId) {
    if (!apiToken || apiToken === 'pending') {
      throw new Error('API токен WordPress не настроен для этого сайта')
    }

    const baseUrl = siteUrl.replace(/\/+$/, '')
    const wpRestUrl = baseUrl + '/wp-json/aipilot/v1'

    // 1. Создаём proposal на WP
    const proposeRes = await fetch(wpRestUrl + '/agent/propose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Pilot-Token': apiToken
      },
      body: JSON.stringify({
        action: action.type,
        params: {
          target: action.target,
          patch: action.patch
        },
        summary: action.title || (action.type + ': ' + JSON.stringify(action.target))
      })
    })

    if (!proposeRes.ok) {
      const errText = await proposeRes.text().catch(() => 'Unknown error')
      throw new Error('WP propose failed: ' + proposeRes.status + ' ' + errText.slice(0, 200))
    }

    const proposal = await proposeRes.json()
    const proposalId = proposal.id || proposal.proposal?.id

    if (!proposalId) {
      throw new Error('WP propose вернул ответ без id')
    }

    // 2. Подтверждаем proposal — WP выполнит действие
    const approveRes = await fetch(wpRestUrl + '/agent/approve/' + proposalId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Pilot-Token': apiToken
      }
    })

    if (!approveRes.ok) {
      const errText = await approveRes.text().catch(() => 'Unknown error')
      throw new Error('WP approve failed: ' + approveRes.status + ' ' + errText.slice(0, 200))
    }

    const result = await approveRes.json()
    return { proposalId, result }
  }

  // Подтвердить действие → выполнить на WP
  app.post('/actions/approve', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { actionId, sessionId, siteUrl, action } = request.body || {}
    if (!actionId) return reply.status(400).send({ error: 'actionId обязателен' })
    if (!action || !action.type) return reply.status(400).send({ error: 'action.type обязателен' })

    // Определяем сайт
    let wpUrl = siteUrl
    if (!wpUrl && sessionId) {
      const session = findSessionById(sessionId)
      if (session) {
        const site = findSiteById(session.site_id)
        if (site) wpUrl = site.url
      }
    }

    const site = findSiteByUserAndUrl(request.user.sub, wpUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })

    let execResult = null
    let execError = null

    try {
      execResult = await executeWpAction(wpUrl, site.api_token, action, actionId)
    } catch (e) {
      execError = e.message
    }

    createAuditEvent({
      userId: request.user.sub, siteId: site.id, sessionId,
      eventType: 'action_approved', entityType: 'action', entityId: actionId,
      payload: { actionId, action, execResult, execError },
      status: execError ? 'failed' : 'completed'
    })

    if (execError) {
      return reply.status(502).send({ status: 'failed', error: execError, actionId })
    }

    return reply.send({ status: 'approved', actionId, wpProposalId: execResult?.proposalId })
  })

  // Отклонить действие (только аудит, WP не трогаем)
  app.post('/actions/reject', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err
    const { actionId, sessionId } = request.body || {}
    if (!actionId) return reply.status(400).send({ error: 'actionId обязателен' })

    createAuditEvent({
      userId: request.user.sub, siteId: null, sessionId,
      eventType: 'action_rejected', entityType: 'action', entityId: actionId,
      payload: { actionId },
      status: 'completed'
    })

    return reply.send({ status: 'rejected', actionId })
  })
}
