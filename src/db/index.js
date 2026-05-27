// db/index.js — единая точка входа в БД-модули
// Все экспорты идентичны старому db.js, просто разнесены по модулям

export { close } from './connection.js'

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
  createChatSession, findSessionsByUserAndSite, findSessionById,
  findOrCreateSession, createMessage, updateMessageStatus, getMessagesBySession,
  updateSessionSummary
} from './chat.js'

export {
  createJob, claimJob, completeJob, failJob, getPendingJobCount,
  registerJobHandler
} from './jobs.js'

export { createAuditEvent } from './audit.js'

export { getStats } from './stats.js'

// Дефолтный экспорт — db инстанс (для прямого доступа, если нужен)
export { default } from './connection.js'
