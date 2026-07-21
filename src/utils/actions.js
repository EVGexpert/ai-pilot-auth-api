/**
 * JSON Schema для валидации структурированного действия от модели.
 */
const ACTION_SCHEMA = {
  type: 'object',
  required: ['type', 'target', 'patch'],
  properties: {
    type: { type: 'string', enum: ['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'] },
    target: { type: 'object', properties: { title: { type: 'string' }, id: { type: ['number', 'string'] }, slug: { type: 'string' } } },
    patch: { type: 'object' },
    requires_approval: { type: 'boolean', default: true }
  }
}

const ACTION_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['answer', 'actions'],
  properties: {
    answer: { type: 'string' },
    actions: {
      type: 'array',
      items: ACTION_SCHEMA
    }
  }
}

/**
 * Простая валидация JSON по схеме.
 */
function validateActionJson(data) {
  if (!data || typeof data !== 'object') return false
  if (!Array.isArray(data.actions) || data.actions.length === 0) return false
  for (const action of data.actions) {
    if (!action.type || !action.target) return false
    if (!['create_post', 'update_post', 'delete_post', 'create_page', 'update_page', 'delete_page', 'update_option', 'update_theme', 'update_menu', 'other'].includes(action.type)) return false
  }
  return true
}

/**
 * Парсит структурированный JSON из ответа модели.
 * Ищет блок ```action ...``` или ```json ...``` в ответе.
 */
function parseStructuredActions(content) {
  // Пробуем найти блок ```action или ```json
  const blockMatch = content.match(/```(?:action|json)\s*([\s\S]*?)```/)
  if (!blockMatch) return null
  try {
    const data = JSON.parse(blockMatch[1])
    if (!validateActionJson(data)) return null
    return data
  } catch (e) {
    return null
  }
}

/**
 * Парсит структурированные действия из ответа модели (```action ... ```).
 * Эвристика отключена — только явный JSON.
 *
 * @param {string} content - ответ модели
 * @returns {{ actions: Array|null, cleanContent: string }}
 */
function parseActions(content) {
  const structured = parseStructuredActions(content)
  // Только структурированный JSON — эвристика отключена
  if (!structured || !validateActionJson(structured)) return null

  const cleanContent = content.replace(/```(?:action|json)\s*[\s\S]*?```/g, '').trim()
  const actions = structured.actions.map(a => ({
    id: 'ap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: a.type.replace(/_/g, ' ') + (a.target?.title ? ': ' + a.target.title : ''),
    description: 'Тип: ' + a.type + (a.target?.slug ? ', цель: ' + a.target.slug : ''),
    diff: Object.entries(a.patch || {}).map(([k, v]) => '+ ' + k + ': ' + String(v).slice(0, 80)),
    status: 'pending',
    raw: { type: a.type, target: a.target, patch: a.patch }
  }))
  return { actions, cleanContent }
}

export {
  ACTION_SCHEMA,
  ACTION_RESPONSE_SCHEMA,
  validateActionJson,
  parseStructuredActions,
  parseActions
}
