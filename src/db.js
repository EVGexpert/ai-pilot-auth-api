// db.js — backward-compatible re-export (refactored into src/db/)
export {
  getConfigValue, setConfigValue,
  findUserByEmail, findUserById, createUser, updateUser,
  findSitesByUser, findSiteByUserAndUrl, findSiteById,
  createSite, updateSiteCache, updateSiteToken, deleteSite, allSites,
  getSiteMemory, getSiteMemoryByKey, setSiteMemory, deleteSiteMemory, formatSiteMemory,
  createVerification, findVerification, deleteVerificationsByUser,
  updateSessionSummary,
  createChatSession, findSessionsByUserAndSite, findSessionById,
  findOrCreateSession, createMessage, updateMessageStatus, getMessagesBySession,
  createJob, claimJob, completeJob, failJob, getPendingJobCount,
  createAuditEvent,
  registerJobHandler,
  getStats, getDbHealth,
  close,
  generateActionKey, createActionRequest, findActionByKey,
  updateActionStatus, getActionsBySession
} from './db/index.js'

export { default } from './db/index.js'
