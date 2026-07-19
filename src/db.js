// db.js — barrel re-export from modular src/db/index.js
// При импорте '../db.js' загружается вся БД через connection.js
// Все экспорты идентичны старому монолитному db.js
// Все функции теперь async — callers должны использовать await

export {
  DB_MODE, ping,
  getConfigValue, setConfigValue,
  findUserByEmail, findUserById, createUser, updateUser,
  createVerification, findVerification, deleteVerificationsByUser,
  findSitesByUser, findSiteByUserAndUrl, findSiteById,
  createSite, updateSiteCache, updateSiteToken, deleteSite, allSites,
  getSiteMemory, getSiteMemoryByKey, setSiteMemory, deleteSiteMemory, formatSiteMemory,
  getCachedProfile, setCachedProfile, isProfileFresh, getAuthoringMode, parseProfile,
  createChatSession, findSessionsByUserAndSite, findSessionById,
  findOrCreateSession, createMessage, updateMessageStatus, getMessagesBySession,
  updateSessionSummary,
  createJob, claimJob, completeJob, failJob, getPendingJobCount,
  registerJobHandler, startWorker, stopWorker,
  createAuditEvent,
  createRefreshToken, findValidRefreshToken, revokeRefreshToken,
  revokeAllUserTokens, cleanExpiredTokens,
  getStats, getDbHealth,
  generateActionKey, createActionRequest, findActionByKey,
  updateActionStatus, getActionsBySession
} from './db/index.js'

export { default } from './db/index.js'
