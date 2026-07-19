// db/index.js — единая точка входа в БД-модули
// Все экспорты идентичны старому db.js, просто разнесены по модулям
// Все функции теперь async — callers должны использовать await

export { close, DB_PATH, DB_MODE, ping } from './connection.js'

export { getConfigValue, setConfigValue } from './config.js'

export {
  findUserByEmail, findUserById, createUser, updateUser,
  createVerification, findVerification, deleteVerificationsByUser
} from './users.js'

export {
  findSitesByUser, findSiteByUserAndUrl, findSiteById,
  createSite, updateSiteCache, updateSiteToken, deleteSite, allSites
} from './sites.js'

export {
  getSiteMemory, getSiteMemoryByKey, setSiteMemory, deleteSiteMemory, formatSiteMemory
} from './site_memory.js'

export {
  getCachedProfile, setCachedProfile, isProfileFresh,
  getAuthoringMode, parseProfile, CAPABILITY_TTL_MS
} from './capability_cache.js'

export {
  createChatSession, findSessionsByUserAndSite, findSessionById,
  findOrCreateSession, createMessage, updateMessageStatus, getMessagesBySession,
  updateSessionSummary, updateSessionTitle
} from './chat.js'

export {
  createJob, claimJob, completeJob, failJob, getPendingJobCount,
  registerJobHandler, startWorker, stopWorker
} from './jobs.js'

export { createAuditEvent } from './audit.js'

export {
  createRefreshToken, findValidRefreshToken,
  revokeRefreshToken, revokeAllUserTokens, cleanExpiredTokens
} from './refresh_tokens.js'

export { getStats, getDbHealth } from './stats.js'

export {
  generateActionKey, createActionRequest, findActionByKey,
  updateActionStatus, getActionsBySession
} from './action_requests.js'

export {
  createCard, getCard, getActiveCards, resolveCard
} from './agent_ui_cards.js'

// Дефолтный экспорт — db инстанс (для прямого доступа, если нужен)
export { default } from './connection.js'
