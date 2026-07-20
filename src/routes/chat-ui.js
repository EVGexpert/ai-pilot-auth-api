import { createCard, getActiveCards, resolveCard, findSiteByUserAndUrl } from '../db.js'
import { verifyToken } from '../middleware/auth.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('chat-ui')

function authGuard(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' })
  const payload = verifyToken(auth.slice(7))
  if (!payload) return reply.status(401).send({ error: 'Invalid token' })
  request.user = payload
}

const VALID_KINDS = ['single_choice', 'multi_choice', 'confirmation', 'form']

export default async function chatUiRoutes(app) {

  app.post('/ui-create', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { site_id, session_id, kind, title, description, options, ttl_seconds } = request.body || {}
    if (!kind || !title) {
      return reply.status(400).send({ error: 'kind и title обязательны' })
    }
    if (!VALID_KINDS.includes(kind)) {
      return reply.status(400).send({ error: `Invalid kind. Must be one of: ${VALID_KINDS.join(', ')}` })
    }

    const card = await createCard({
      siteId: site_id,
      sessionId: session_id,
      userId: request.user.sub,
      kind,
      title,
      description,
      options,
      ttlSeconds: ttl_seconds
    })

    return reply.status(201).send({ card })
  })

  app.get('/ui-active', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { site_id, site_url, session_id } = request.query
    if (!session_id) {
      return reply.status(400).send({ error: 'session_id обязателен' })
    }
    if (!site_id && !site_url) {
      return reply.status(400).send({ error: 'site_id или site_url обязательны' })
    }

    let resolvedSiteId = site_id
    if (!resolvedSiteId && site_url) {
      const site = await findSiteByUserAndUrl(request.user.sub, site_url)
      if (!site) {
        return reply.status(404).send({ error: 'Сайт не найден' })
      }
      resolvedSiteId = site.id
    }

    const cards = await getActiveCards({ siteId: resolvedSiteId, sessionId: session_id })
    return reply.send({ cards })
  })

  app.post('/ui-respond/:id', async (request, reply) => {
    const err = authGuard(request, reply)
    if (err) return err

    const { id } = request.params
    const { option_id } = request.body || {}

    try {
      const card = await resolveCard(id, { optionId: option_id })
      return reply.send({ card })
    } catch (e) {
      return reply.status(400).send({ error: e.message })
    }
  })
}
