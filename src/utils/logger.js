/**
 * Structured JSON Logger
 *
 * Outputs one JSON object per line with: timestamp, level, service, traceId, event, message, …extra fields.
 * No external dependencies — uses built-in crypto.randomUUID when available.
 *
 * Usage:
 *   import { createLogger } from '../utils/logger.js'
 *   const log = createLogger('auth-api')
 *
 *   log.info({ traceId, event: 'request_start', method, url }, 'Incoming request')
 *   log.error({ traceId, event: 'db_error', err: e.message }, 'Database failed')
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

const LEVEL_STYLE = {
  debug: '\x1b[36m',  // cyan
  info:  '\x1b[32m',  // green
  warn:  '\x1b[33m',  // yellow
  error: '\x1b[31m'   // red
}
const RESET = '\x1b[0m'

/**
 * Detect minimum log level from LOG_LEVEL env var (default: debug).
 */
function minLevel() {
  const env = (process.env.LOG_LEVEL || 'debug').toLowerCase()
  return LEVELS[env] !== undefined ? LEVELS[env] : LEVELS.debug
}

/**
 * Create a scoped logger.
 * @param {string} service - Service name included in every entry.
 * @returns {{ debug, info, warn, error, child }}
 */
export function createLogger(service = 'auth-api') {
  const _min = minLevel()

  function write(level, data, message) {
    if (LEVELS[level] < _min) return

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      ...(data || {}),
      message: message || ''
    }

    // Pretty-print in non-production for readability
    const isProd = process.env.NODE_ENV === 'production'
    const line = isProd
      ? JSON.stringify(entry)
      : `${LEVEL_STYLE[level]}${level.toUpperCase().padEnd(5)}${RESET} ${entry.timestamp} ${entry.traceId ? `[${entry.traceId}] ` : ''}${entry.message} ${isProd ? '' : JSON.stringify({ ...entry, timestamp: undefined, level: undefined, service: undefined, message: undefined, traceId: undefined })}`

    const stream = level === 'error' ? process.stderr : process.stdout
    stream.write(line + '\n')
  }

  return {
    debug(data, msg) { write('debug', data, msg) },
    info(data, msg)  { write('info',  data, msg) },
    warn(data, msg)  { write('warn',  data, msg) },
    error(data, msg) { write('error', data, msg) },

    /**
     * Create a child logger that always includes the given fields (e.g. traceId).
     * @param {object} defaults - Fields merged into every log entry.
     */
    child(defaults = {}) {
      const parent = this
      return {
        debug(data, msg) { parent.debug({ ...defaults, ...data }, msg) },
        info(data, msg)  { parent.info({ ...defaults, ...data },  msg) },
        warn(data, msg)  { parent.warn({ ...defaults, ...data },  msg) },
        error(data, msg) { parent.error({ ...defaults, ...data }, msg) },
        child(more)      { return parent.child({ ...defaults, ...more }) }
      }
    }
  }
}

export default createLogger
