import { queryOne, queryAll, run, uid, now } from './connection.js'

export async function createAuditEvent({ userId, siteId, sessionId, eventType, entityType, entityId, payload, ipAddress, userAgent, requestId, status }) {
  const id = uid(); const t = now()
  const payloadStr = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null
  await run('INSERT INTO audit_events (id, user_id, site_id, session_id, event_type, entity_type, entity_id, payload_json, ip_address, user_agent, request_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, userId || null, siteId || null, sessionId || null, eventType, entityType || null, entityId || null,
     payloadStr, ipAddress || null, userAgent || null, requestId || null, status || null, t])
  return id
}
