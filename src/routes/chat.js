import { findSitesByUser, findSiteByUserAndUrl, findSiteById, updateSiteCache, findOrCreateSession, findSessionById, findSessionsByUserAndSite, createChatSession, createMessage, updateMessageStatus, getMessagesBySession, createJob, createAuditEvent, registerJobHandler, getConfigValue, updateSessionSummary, updateSessionTitle, formatSiteMemory, setSiteMemory, generateActionKey, createActionRequest, findActionByKey, updateActionStatus } from '../db.js'
import { verifyToken } from '../middleware/auth.js'
import { CORE_RULES, GREETING_INSTRUCTION } from '../config/prompt.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('chat')

// Используется для Authorization header во всех запросах к Gateway
const AUTH_PREFIX = 'Bearer '

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try { const res = await fetch(url, { ...options, signal: controller.signal }); return res }
  finally { clearTimeout(timeout) }
}

registerJobHandler('refresh_context', async (job) => {
  const { siteUrl, apiToken } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  const ctxRes = await fetch(siteUrl.replace(/\/+$/, '') + '/wp-json/aipilot/v1/agent/context', { headers: { 'X-AI-Pilot-Token': apiToken }, signal: controller.signal })
  clearTimeout(timeout)
  if (ctxRes.ok) {
    const ctx = await ctxRes.json()
    const site = await findSiteByUserAndUrl(job.user_id, siteUrl)
    if (site) await updateSiteCache(site.id, { cached_structure: JSON.stringify(ctx.structure || ctx), cached_soul: JSON.stringify(ctx.soul || {}), cached_at: new Date().toISOString() })
  }
})

registerJobHandler('sync_wp_memory', async (job) => {
  const { siteUrl, apiToken, message, response, agentId } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const memoryUrl = siteUrl.replace(/\/+$/, '') + '/wp-json/aipilot/v1/agent/memory'
  const resp = await fetchWithTimeout(memoryUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Pilot-Token': apiToken }, body: JSON.stringify({ action: 'client_message', summary: message.slice(0, 200), details: { response: (response || '').slice(0, 500), agentId }, agent: 'client' }) }, 5000)
  if (!resp.ok) throw new Error('WP memory sync: ' + resp.status)
})

function authGuard(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' })
  const payload = verifyToken(auth.slice(7))
  if (!payload) return reply.status(401).send({ error: 'Invalid token' })
  request.user = payload; return null
}

function getAgentId(url) {
  return 'site-' + url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase()
}

function buildSystemPrompt(site, siteUrl, message, contextSummary) {
  const isGreeting = message.trim() === '/start'
  return 'Ты AI-помощник для сайта ' + (site.name || siteUrl) + '.' + contextSummary + '\n\nПравила:\n' + CORE_RULES + (isGreeting ? '\n\n' + GREETING_INSTRUCTION : '')
}

const ACTION_SCHEMA = {
  type: 'object', required: ['type', 'target', 'patch'],
  properties: { type: { type: 'string', enum: ['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'] }, target: { type: 'object', properties: { title: { type: 'string' }, id: { type: ['number', 'string'] }, slug: { type: 'string' } } }, patch: { type: 'object' }, requires_approval: { type: 'boolean', default: true } }
}

function validateActionJson(data) {
  if (!data || typeof data !== 'object') return false
  if (!Array.isArray(data.actions) || data.actions.length === 0) return false
  for (const a of data.actions) { if (!a.type || !a.target) return false; if (!['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'].includes(a.type)) return false }
  return true
}

function parseStructuredActions(content) {
  const m = content.match(/```(?:action|json)\s*([\s\S]*?)```/)
  if (!m) return null
  try { const d = JSON.parse(m[1]); return validateActionJson(d) ? d : null }
  catch(e) { return null }
}

function parseActions(content) {
  const structured = parseStructuredActions(content)
  if (!structured || !validateActionJson(structured)) return null
  const cleanContent = content.replace(/```(?:action|json)\s*[\s\S]*?```/g, '').trim()
  const actions = structured.actions.map(a => ({
    id: 'ap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: a.type.replace(/_/g, ' ') + (a.target?.title ? ': ' + a.target.title : ''),
    description: 'Тип: ' + a.type + (a.target?.slug ? ', цель: ' + a.target.slug : ''),
    diff: Object.entries(a.patch || {}).map(([k, v]) => '+ ' + k + ': ' + String(v).slice(0, 80)),
    status: 'pending', raw: { type: a.type, target: a.target, patch: a.patch }
  }))
  return { actions, cleanContent }
}

async function generateSessionTitle(sessionId, message, displayContent) {
  // Берём ключ из DEEPSEEK_API_KEY или первого из DEEPSEEK_API_KEYS
  let apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey && process.env.DEEPSEEK_API_KEYS) {
    apiKey = process.env.DEEPSEEK_API_KEYS.split(',')[0].trim()
  }
  if (!apiKey) return

  try {
    const titleResp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Придумай заголовок из 2-3 слов на русском языке для этого диалога. Ответь только этими 2-3 словами, без кавычек, эмодзи и знаков препинания.' },
          { role: 'user', content: 'Клиент: ' + message + '\n\nАссистент: ' + displayContent }
        ],
        max_tokens: 30,
        temperature: 0.3
      })
    })
    if (titleResp.ok) {
      const titleData = await titleResp.json()
      const newTitle = titleData.choices?.[0]?.message?.content?.trim()
      if (newTitle && newTitle.length < 50) {
        await updateSessionTitle(sessionId, newTitle)
      }
    }
  } catch (e) {
    // fire-and-forget, игнорируем ошибки
  }
}

export default async function chatRoutes(app) {
  const FULL_PROMPT = 'Ты AI-помощник для WordPress-сайта.\n\nПравила:\n' + CORE_RULES

  app.get('/prompt', async (_, reply) => reply.send({ prompt: FULL_PROMPT, coreRules: CORE_RULES, version: '1.0.0' }))

  app.post('/send', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { message, siteUrl, sessionId } = request.body || {}
    if (!message || !siteUrl) return reply.status(400).send({ error: 'message и siteUrl обязательны' })
    const site = await findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
    if (!site.api_token || site.api_token === 'pending') return reply.status(400).send({ error: 'API токен не найден' })

    let session
    if (sessionId) {
      const es = await findSessionById(sessionId)
      session = (es && es.user_id === request.user.sub && es.site_id === site.id) ? es : await createChatSession({ userId: request.user.sub, siteId: site.id, title: 'Чат' })
    } else {
      session = await findOrCreateSession(request.user.sub, site.id)
    }

    let contextSummary = ''
    const cacheAge = site.cached_at ? (Date.now() - new Date(site.cached_at).getTime()) / 1000 : Infinity
    if (site.cached_structure && cacheAge < 3600) {
      try {
        const struct = typeof site.cached_structure === 'string' ? JSON.parse(site.cached_structure) : site.cached_structure
        if (struct?.site) contextSummary = '\nКонтекст сайта (из кэша):\n- Название: ' + (struct.site.name || site.name) + '\n- Описание: ' + (struct.site.description || '') + '\n- WP: ' + (struct.site.wp_version || '') + '\n- Плагины: ' + (struct.plugins?.active || 0) + ' активных\n- Посты: ' + (struct.content?.posts?.length || 0) + '\n- Страницы: ' + (struct.content?.pages?.length || 0)
      } catch(e) {}
    }
    if (!contextSummary) await createJob({ type: 'refresh_context', siteId: site.id, userId: request.user.sub, payload: { siteUrl, apiToken: site.api_token }, maxAttempts: 1 })

    const siteMemoryBlock = await formatSiteMemory(site.id)
    const memoryContext = siteMemoryBlock ? '\n\nПамять о предыдущих решениях:\n' + siteMemoryBlock : ''
    const systemPrompt = buildSystemPrompt(site, siteUrl, message, contextSummary + memoryContext)

    const userMsg = await createMessage({ sessionId: session.id, role: 'user', content: message, metadata: { siteUrl }, source: 'client', status: 'received' })
    const agentId = getAgentId(siteUrl)
    const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:18789'
    let gatewayToken = await getConfigValue('gateway_token')
    if (!gatewayToken) gatewayToken = process.env.GATEWAY_TOKEN || process.env.VITE_GATEWAY_TOKEN || ''
    if (!gatewayToken || gatewayToken === 'dev-gateway-token') return reply.status(500).send({ error: 'GATEWAY_TOKEN не настроен' })

    try {
      const model = 'openclaw'
      const prefixedMessage = '[client:' + siteUrl + '] ' + message
      const historyMessages = (await getMessagesBySession(session.id)).slice(-12).map(m => ({ role: m.role, content: m.content }))
      let summaryBlock = ''
      if (session.summary && historyMessages.length >= 8) summaryBlock = '\n\nКонтекст сессии:\n' + session.summary
      const messages = [{ role: 'system', content: systemPrompt + summaryBlock }, ...historyMessages, { role: 'user', content: prefixedMessage }]
      const body = JSON.stringify({ model, messages, user: siteUrl, max_tokens: 4096, stream: false })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const resp = await fetch(gatewayUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_PREFIX + gatewayToken, 'X-Trace-ID': request.traceId }, signal: controller.signal, body })
      clearTimeout(timeout)

      if (!resp.ok) { const t = await resp.text(); await updateMessageStatus(userMsg.id, 'failed'); return reply.status(resp.status).send({ error: 'Gateway request failed', detail: t.slice(0, 500) }) }

      const data = await resp.json()
      const rawContent = data.choices?.[0]?.message?.content || ''
      const parsed = parseActions(rawContent)
      const actions = parsed?.actions || null
      const displayContent = parsed?.cleanContent || rawContent

      await updateMessageStatus(userMsg.id, 'sent')
      await createMessage({ sessionId: session.id, role: 'assistant', content: displayContent, metadata: { agentId, model, actions: actions ? JSON.stringify(actions) : null }, source: 'gateway', status: 'sent' })

      if (message.trim() !== '/start') await createJob({ type: 'sync_wp_memory', siteId: site.id, userId: request.user.sub, sessionId: session.id, payload: { siteUrl, apiToken: site.api_token, message, response: displayContent, agentId }, maxAttempts: 3 })

      await updateSessionSummary(session.id)

      await createAuditEvent({ userId: request.user.sub, siteId: site.id, sessionId: session.id, eventType: 'chat_message', entityType: 'message', entityId: 'assistant', payload: { role: 'assistant', hasActions: !!actions }, traceId: request.traceId, status: 'sent' })

      if (session.title === 'Чат') {
        generateSessionTitle(session.id, message, displayContent).catch(e => log.warn('Title gen error:', e.message))
      }

      return reply.send({ message: displayContent, actions, agentId, siteUrl, sessionId: session.id, messageId: userMsg.id })
    } catch (e) {
      if (userMsg) await updateMessageStatus(userMsg.id, 'failed')
      return reply.status(502).send({ error: 'Chat proxy failed: ' + e.message })
    }
  })

  app.get('/sessions', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { siteUrl } = request.query
    if (!siteUrl) return reply.status(400).send({ error: 'siteUrl обязателен' })
    const site = await findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
    const sessions = await findSessionsByUserAndSite(request.user.sub, site.id)
    const result = []
    for (const s of sessions) {
      const msgs = await getMessagesBySession(s.id)
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null
      result.push({ id: s.id, title: s.title || 'Чат', preview: lastMsg ? lastMsg.content.slice(0, 60) : '', date: s.created_at.slice(0, 10), createdAt: s.created_at, updatedAt: s.updated_at, messageCount: msgs.length, lastMessage: lastMsg ? { role: lastMsg.role, created_at: lastMsg.created_at } : null })
    }
    return reply.send({ sessions: result })
  })

  app.post('/new', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { siteUrl } = request.body || {}
    if (!siteUrl) return reply.status(400).send({ error: 'siteUrl обязателен' })
    const site = await findSiteByUserAndUrl(request.user.sub, siteUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
    const session = await createChatSession({ userId: request.user.sub, siteId: site.id, title: 'Чат' })
    return reply.send({ sessionId: session.id })
  })

  app.get('/history', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { siteUrl, sessionId } = request.query
    if (!siteUrl && !sessionId) return reply.status(400).send({ error: 'Укажите siteUrl или sessionId' })
    let sid = sessionId
    if (sid) {
      const session = await findSessionById(sid)
      if (!session || session.user_id !== request.user.sub) return reply.status(403).send({ error: 'Session not found or access denied' })
    } else {
      const site = await findSiteByUserAndUrl(request.user.sub, siteUrl)
      if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
      const sessions = await findSessionsByUserAndSite(request.user.sub, site.id)
      if (sessions.length === 0) return reply.send({ messages: [], sessionId: null })
      sid = sessions[0].id
    }
    const messages = await getMessagesBySession(sid)
    return reply.send({ messages, sessionId: sid })
  })

  async function executeWpAction(siteUrl, apiToken, action, actionId, traceId) {
    if (!apiToken || apiToken === 'pending') throw new Error('API токен WordPress не настроен')
    const baseUrl = siteUrl.replace(/\/+$/, '')
    const wpRestUrl = baseUrl + '/wp-json/aipilot/v1'
    const proposeRes = await fetchWithTimeout(wpRestUrl + '/agent/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Pilot-Token': apiToken, 'X-Trace-ID': traceId || '' }, body: JSON.stringify({ action: action.type, params: { target: action.target, patch: action.patch }, summary: action.title || (action.type + ': ' + JSON.stringify(action.target)) }) }, 15000)
    if (!proposeRes.ok) { const t = await proposeRes.text().catch(() => ''); throw new Error('WP propose failed: ' + proposeRes.status + ' ' + t.slice(0, 200)) }
    const proposal = await proposeRes.json()
    const proposalId = proposal.id || proposal.proposal?.id
    if (!proposalId) throw new Error('WP propose без id')
    const approveRes = await fetchWithTimeout(wpRestUrl + '/agent/approve/' + proposalId, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Pilot-Token': apiToken, 'X-Trace-ID': traceId || '' } }, 15000)
    if (!approveRes.ok) { const t = await approveRes.text().catch(() => ''); throw new Error('WP approve failed: ' + approveRes.status + ' ' + t.slice(0, 200)) }
    const result = await approveRes.json()
    return { proposalId, result }
  }

  app.post('/actions/approve', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { actionId, sessionId, siteUrl, action } = request.body || {}
    if (!actionId) return reply.status(400).send({ error: 'actionId обязателен' })
    if (!action || !action.type) return reply.status(400).send({ error: 'action.type обязателен' })
    const idempotencyKey = generateActionKey(action)
    const existing = await findActionByKey(idempotencyKey)
    if (existing && existing.status === 'completed' && existing.result_json) return reply.send({ status: 'approved', actionId, wpProposalId: JSON.parse(existing.result_json)?.proposalId, idempotent: true, cached: true })
    let wpUrl = siteUrl
    if (!wpUrl && sessionId) { const s = await findSessionById(sessionId); if (s) { const si = await findSiteById(s.site_id); if (si) wpUrl = si.url } }
    const site = await findSiteByUserAndUrl(request.user.sub, wpUrl)
    if (!site) return reply.status(403).send({ error: 'Сайт не привязан' })
    const actionReq = existing || await createActionRequest({ userId: request.user.sub, siteId: site.id, sessionId, action })
    if (actionReq.status === 'processing') return reply.status(409).send({ error: 'Действие уже выполняется', actionId })
    await updateActionStatus(actionReq.id, 'processing')
    let er = null, ee = null
    try { er = await executeWpAction(wpUrl, site.api_token, action, actionId, request.traceId) } catch (e) { ee = e.message }
    await createAuditEvent({ userId: request.user.sub, siteId: site.id, sessionId, eventType: 'action_approved', entityType: 'action', entityId: actionId, payload: { actionId, action, execResult: er, execError: ee, idempotencyKey }, traceId: request.traceId, status: ee ? 'failed' : 'completed' })
    await updateActionStatus(actionReq.id, ee ? 'failed' : 'completed', { proposalId: er?.proposalId, result: er })
    if (ee) return reply.status(502).send({ status: 'failed', error: ee, actionId })
    return reply.send({ status: 'approved', actionId, wpProposalId: er?.proposalId, idempotent: false })
  })

  app.post('/actions/reject', async (request, reply) => {
    const err = authGuard(request, reply); if (err) return err
    const { actionId, sessionId } = request.body || {}
    if (!actionId) return reply.status(400).send({ error: 'actionId обязателен' })
    await createAuditEvent({ userId: request.user.sub, siteId: null, sessionId, eventType: 'action_rejected', entityType: 'action', entityId: actionId, payload: { actionId }, traceId: request.traceId, status: 'completed' })
    return reply.send({ status: 'rejected', actionId })
  })
}