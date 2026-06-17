import { queryOne, queryAll, run, uid, now, DB_MODE } from './connection.js'

// ============================================================
// JOB CREATION
// ============================================================

export async function createJob({ type, siteId, userId, sessionId, payload, maxAttempts = 5 }) {
  const id = uid(); const t = now()
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
  await run('INSERT INTO jobs (id, type, site_id, user_id, session_id, payload_json, status, max_attempts, run_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, type, siteId || null, userId || null, sessionId || null, payloadStr, 'pending', maxAttempts, t, t, t])
  return id
}

// ============================================================
// JOB CLAIMING — pessimistic locking
// ============================================================

/**
 * Claim a pending job for processing.
 *
 * PostgreSQL: uses SELECT ... FOR UPDATE SKIP LOCKED inside a transaction,
 * which guarantees that no two workers can claim the same row.
 *
 * SQLite: uses a single-statement UPDATE with a subquery (rowid-based)
 * and checks the affected row count. Because SQLite uses database-level
 * write locks, concurrent writers are serialized naturally.
 */
export async function claimJob(workerId = 'worker-1') {
  const t = now()

  if (DB_MODE === 'postgresql') {
    return await _claimPg(workerId, t)
  } else {
    return await _claimSqlite(workerId, t)
  }
}

async function _claimPg(workerId, t) {
  const pool = (await import('./pg.js')).default
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Find & lock a pending job — SKIP LOCKED skips rows already locked by other workers
    const { rows } = await client.query(
      `SELECT id, type, site_id, user_id, session_id, payload_json, status,
              attempts, max_attempts, run_after, locked_at, locked_by, last_error,
              created_at, updated_at
       FROM jobs
       WHERE status = 'pending' AND (run_after IS NULL OR run_after <= $1)
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [t]
    )

    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }

    const job = rows[0]

    await client.query(
      `UPDATE jobs
       SET status = 'processing', locked_at = $1, locked_by = $2,
           attempts = attempts + 1, updated_at = $1
       WHERE id = $3`,
      [t, workerId, job.id]
    )

    await client.query('COMMIT')
    return _normalizeJob(job)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function _claimSqlite(workerId, t) {
  // SQLite: find the oldest pending job and atomically claim it.
  // Because SQLite serializes writes, two concurrent workers cannot
  // both update the same row. We verify with changes count.
  const job = await queryOne(
    "SELECT * FROM jobs WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at ASC LIMIT 1",
    [t]
  )
  if (!job) return null

  const result = await run(
    "UPDATE jobs SET status = 'processing', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
    [t, workerId, t, job.id]
  )

  // If changes === 0, another worker grabbed it first
  if (!result.changes) return null

  return await queryOne('SELECT * FROM jobs WHERE id = ?', [job.id])
}

/** Normalize PG row (snake_case) to match SQLite output shape */
function _normalizeJob(row) {
  // PG returns snake_case column names; SQLite returns what was defined.
  // Since our queries use snake_case everywhere, both should match.
  // Just ensure consistent shape.
  return {
    id: row.id,
    type: row.type,
    site_id: row.site_id ?? row.siteId ?? null,
    user_id: row.user_id ?? row.userId ?? null,
    session_id: row.session_id ?? row.sessionId ?? null,
    payload_json: row.payload_json ?? row.payloadJson ?? '',
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts ?? row.maxAttempts ?? 5,
    run_after: row.run_after ?? row.runAfter ?? null,
    locked_at: row.locked_at ?? row.lockedAt ?? null,
    locked_by: row.locked_by ?? row.lockedBy ?? null,
    last_error: row.last_error ?? row.lastError ?? null,
    created_at: row.created_at ?? row.createdAt ?? '',
    updated_at: row.updated_at ?? row.updatedAt ?? ''
  }
}

// ============================================================
// JOB COMPLETION & FAILURE
// ============================================================

export async function completeJob(id, result) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  await run(
    "UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, payload_json = ?, updated_at = ? WHERE id = ?",
    [resultStr, now(), id]
  )
}

export async function failJob(id, error) {
  const j = await queryOne('SELECT * FROM jobs WHERE id = ?', [id])
  if (!j) return
  if (j.attempts >= j.max_attempts) {
    await run(
      "UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?",
      [String(error), now(), id]
    )
  } else {
    // Retry after exponential backoff: 5s * 2^(attempts-1), capped at 60s
    const backoffMs = Math.min(5000 * Math.pow(2, j.attempts - 1), 60000)
    const runAfter = new Date(Date.now() + backoffMs).toISOString().replace('T', ' ').slice(0, 19)
    await run(
      "UPDATE jobs SET status = 'pending', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ?, run_after = ? WHERE id = ?",
      [String(error), now(), runAfter, id]
    )
  }
}

// ============================================================
// STALE JOB RECOVERY
// ============================================================

const STALE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Reset jobs that have been stuck in 'processing' state for too long.
 * This handles worker crashes where jobs were claimed but never completed.
 */
async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString().replace('T', ' ').slice(0, 19)
  try {
    const result = await run(
      `UPDATE jobs
       SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = ?
       WHERE status = 'processing' AND locked_at < ?`,
      [now(), cutoff]
    )
    if (result.changes > 0) {
      console.log(`[Worker] Recovered ${result.changes} stale job(s)`)
    }
  } catch (e) {
    console.error('[Worker] Stale job recovery failed:', e.message)
  }
}

// ============================================================
// JOB HANDLERS
// ============================================================

const JOB_HANDLERS = {}

export function registerJobHandler(type, handler) {
  JOB_HANDLERS[type] = handler
}

// ============================================================
// WORKER LIFECYCLE
// ============================================================

const WORKER_POLL_INTERVAL_MS = 2000
const STALE_CHECK_INTERVAL_MS = 30_000

let workerTimer = null
let staleTimer = null
let processing = false
const workerId = `worker-${uid()}`

async function processNextJob() {
  if (processing) return // Don't overlap
  processing = true
  try {
    const job = await claimJob(workerId)
    if (!job) return

    const handler = JOB_HANDLERS[job.type]
    if (!handler) {
      await failJob(job.id, 'No handler for type: ' + job.type)
      return
    }

    try {
      const result = await handler(job)
      await completeJob(job.id, result)
    } catch (e) {
      await failJob(job.id, e.message)
      console.warn('[Worker] Job', job.id, job.type, 'failed:', e.message)
    }
  } catch (e) {
    console.error('[Worker] Claim/process error:', e.message)
  } finally {
    processing = false
  }
}

/**
 * Start the background worker loop.
 * Uses setInterval with unref() so it doesn't prevent process exit.
 */
export function startWorker() {
  if (workerTimer) return // Already running

  console.log(`[Worker] Starting (id=${workerId}, mode=${DB_MODE}, poll=${WORKER_POLL_INTERVAL_MS}ms)`)

  // Main poll loop
  workerTimer = setInterval(() => {
    processNextJob().catch(e => {
      console.error('[Worker] Unexpected error in poll:', e.message)
    })
  }, WORKER_POLL_INTERVAL_MS)
  workerTimer.unref() // Don't keep process alive for this timer

  // Stale job recovery loop
  staleTimer = setInterval(() => {
    recoverStaleJobs().catch(e => {
      console.error('[Worker] Stale recovery error:', e.message)
    })
  }, STALE_CHECK_INTERVAL_MS)
  staleTimer.unref()

  // Process immediately on start (after a short delay for startup)
  setTimeout(() => {
    processNextJob().catch(() => {})
  }, 500)
}

/**
 * Stop the background worker loop.
 */
export function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
  if (staleTimer) {
    clearInterval(staleTimer)
    staleTimer = null
  }
  console.log('[Worker] Stopped')
}

// ============================================================
// UTILS
// ============================================================

export async function getPendingJobCount() {
  return (await queryOne("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'"))?.c || 0
}
