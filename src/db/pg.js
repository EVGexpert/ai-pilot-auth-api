import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
})

pool.on('error', (err) => {
  console.error('[PG] Unexpected pool error:', err.message)
})

pool.on('connect', (client) => {
  console.log('[PG] New client connected, pool size:', pool.totalCount)
})

export default pool
