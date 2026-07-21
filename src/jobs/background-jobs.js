/**
 * Background job handlers for chat routes.
 * Side-effect import: registers handlers on module load.
 *
 * Handlers:
 * - refresh_context: fetches site context + capabilities from WP
 * - sync_wp_memory: pushes conversation memory to WP
 */
import { findSiteByUserAndUrl, updateSiteCache, registerJobHandler, setCachedProfile } from '../db.js'
import { fetchWithTimeout } from '../utils/fetch.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('jobs')

registerJobHandler('refresh_context', async (job) => {
  const { siteUrl, apiToken } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const base = siteUrl.replace(/\/+$/, '')
  const site = await findSiteByUserAndUrl(job.user_id, siteUrl)

  // 1) Site context (structure + soul) — существующий flow
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  const ctxRes = await fetch(
    base + '/wp-json/aipilot/v1/agent/context',
    { headers: { 'X-AI-Pilot-Token': apiToken }, signal: controller.signal }
  )
  clearTimeout(timeout)
  if (ctxRes.ok) {
    const ctx = await ctxRes.json()
    if (site) {
      await updateSiteCache(site.id, {
        cached_structure: JSON.stringify(ctx.structure || ctx),
        cached_soul: JSON.stringify(ctx.soul || {}),
        cached_at: new Date().toISOString()
      })
    }
  }

  // 2) Capability profile (GET /agent/capabilities) — Mode Router
  //    Fallback: 404/5xx/таймаут = старый плагин, работаем как раньше.
  if (site) {
    try {
      const capRes = await fetchWithTimeout(
        base + '/wp-json/aipilot/v1/agent/capabilities',
        { headers: { 'X-AI-Pilot-Token': apiToken } },
        3000
      )
      if (capRes.ok) {
        const profile = await capRes.json()
        if (profile && typeof profile === 'object') {
          await setCachedProfile(site.id, profile)
        }
      }
    } catch (e) {
      log.warn({ event: 'capabilities_fetch_failed', siteId: site.id, err: e.message }, 'Capability profile fetch failed (fallback)')
    }
  }
})

registerJobHandler('sync_wp_memory', async (job) => {
  const { siteUrl, apiToken, message, response, agentId } = JSON.parse(job.payload_json)
  if (!apiToken || apiToken === 'pending') return
  const memoryUrl = siteUrl.replace(/\/+$/, '') + '/wp-json/aipilot/v1/agent/memory'
  const resp = await fetchWithTimeout(memoryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AI-Pilot-Token': apiToken },
    body: JSON.stringify({
      action: 'client_message', summary: message.slice(0, 200),
      details: { response: (response || '').slice(0, 500), agentId }, agent: 'client'
    })
  }, 5000)
  if (!resp.ok) throw new Error('WP memory sync: ' + resp.status)
})
