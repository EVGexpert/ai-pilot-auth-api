import { queryOne, queryAll, run, uid, now } from './connection.js'

export function createJob({ type, siteId, userId, sessionId, payload, maxAttempts = 5 }) {
  const id = uid(); const t = now()
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
  run('INSERT INTO jobs (id, type, site_id, user_id, session_id, payload_json, status, max_attempts, run_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, type, siteId || null, userId || null, sessionId || null, payloadStr, 'pending', maxAttempts, t, t, t])
  return id
}

export function claimJob() {
  const t = now()
  const job = queryOne("SELECT * FROM jobs WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at ASC LIMIT 1", [t])
  if (!job) return null
  run("UPDATE jobs SET status = 'processing', locked_at = ?, locked_by = 'worker', attempts = attempts + 1, updated_at = ? WHERE id = ?", [t, t, job.id])
  return queryOne('SELECT * FROM jobs WHERE id = ?', [job.id])
}

export function completeJob(id, result) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
  run("UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, payload_json = ?, updated_at = ? WHERE id = ?", [resultStr, now(), id])
}

export function failJob(id, error) {
  const j = queryOne('SELECT * FROM jobs WHERE id = ?', [id])
  if (!j) return
  if (j.attempts >= j.max_attempts) {
    run("UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?", [String(error), now(), id])
  } else {
    run("UPDATE jobs SET status = 'pending', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ?, run_after = ? WHERE id = ?",
      [String(error), now(), new Date(Date.now() + 5000).toISOString().replace('T', ' ').slice(0, 19), id])
  }
}

export function getPendingJobCount() {
  return queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'")?.c || 0
}

// ============================================================
// JOB HANDLERS & WORKER
// ============================================================
const JOB_HANDLERS = {}
export function registerJobHandler(type, handler) { JOB_HANDLERS[type] = handler }

async function processJob(job) {
  const handler = JOB_HANDLERS[job.type]
  if (!handler) { failJob(job.id, 'No handler for type: ' + job.type); return }
  try {
    const result = await handler(job)
    completeJob(job.id, result)
  } catch (e) {
    failJob(job.id, e.message)
    console.warn('[Worker] Job', job.id, job.type, 'failed:', e.message)
  }
}

let workerRunning = false
async function workerLoop() {
  if (workerRunning) return
  workerRunning = true
  while (true) {
    try {
      const job = claimJob()
      if (job) { await processJob(job) }
      else { await new Promise(r => setTimeout(r, 2000)) }
    } catch (e) {
      console.error('[Worker] Loop error:', e.message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
setTimeout(() => workerLoop().catch(() => {}), 1000)
