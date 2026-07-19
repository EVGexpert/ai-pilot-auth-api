import { queryOne, queryAll, run, uid, now } from './connection.js'

const VALID_KINDS = ['single_choice', 'multi_choice', 'confirmation', 'form']
const DEFAULT_TTL_SECONDS = 300

export async function createCard({ siteId, sessionId, userId, kind, title, description, options, ttlSeconds }) {
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`Invalid kind: ${kind}`)
  }

  const id = uid()
  const t = now()
  const expiresAt = new Date(Date.now() + (ttlSeconds || DEFAULT_TTL_SECONDS) * 1000)
    .toISOString().replace('T', ' ').slice(0, 19)

  await run(`INSERT INTO agent_ui_cards (id, site_id, session_id, user_id, kind, title, description, options, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, siteId || null, sessionId || null, userId, kind, title, description || null, JSON.stringify(options || []), t, expiresAt])

  return await getCard(id)
}

export async function getCard(id) {
  return await queryOne('SELECT * FROM agent_ui_cards WHERE id = ?', [id])
}

export async function getActiveCards({ siteId, sessionId }) {
  return await queryAll(
    `SELECT * FROM agent_ui_cards WHERE site_id = ? AND session_id = ? AND status = 'active' AND expires_at > ? ORDER BY created_at ASC`,
    [siteId, sessionId, now()]
  )
}

export async function resolveCard(id, { optionId } = {}) {
  const card = await getCard(id)
  if (!card) throw new Error('Card not found')
  if (card.status !== 'active') throw new Error('Card is not active')

  const options = JSON.parse(card.options || '[]')
  if (optionId && options.length > 0) {
    const exists = options.some(o => {
      if (typeof o === 'string') return o === optionId
      return o.id === optionId || o.value === optionId
    })
    if (!exists) throw new Error('Invalid option')
  }

  const t = now()
  await run(`UPDATE agent_ui_cards SET status = 'resolved', resolved_at = ? WHERE id = ?`, [t, id])
  return await getCard(id)
}
