# AI Pilot — Аудит схемы привязки пользователя и сохранения

**Дата:** 2026-06-01
**Проверял:** Zero 🎯
**Кодовые базы:** ai-pilot-auth-api, ai-pilot-wp-plugin

---

## 1. Архитектура привязки

```
┌──────────┐       ┌──────────────┐       ┌──────────────┐       ┌─────────────┐
│  Клиент  │ ───→  │  auth-api    │ ───→  │  WordPress   │       │  Gateway    │
│ (веб-чат)│ ←───  │  :3001       │ ←───  │  Plugin API  │       │  :18789     │
└──────────┘       └──────┬───────┘       └──────────────┘       └──────┬──────┘
                          │                                              │
                    ┌─────▼──────┐                                ┌──────▼──────┐
                    │  SQLite    │                                │  Zero       │
                    │  aipilot.db│                                │  (main)     │
                    └────────────┘                                └─────────────┘
```

## 2. Потоки (flows)

### 2.1 Регистрация → `POST /api/auth/register`

```
Клиент → auth-api: { email, password, name? }
  ↓
1. Проверка email уникальность → 409 если занят
2. hashPassword(password) — bcrypt/argon2id (асинхронный)
3. createUser({ email, passwordHash, name, role })
   role = 'admin' если email содержит 'admin', иначе 'client'
4. generateToken(user) → JWT { sub, email, role }
   JWT_EXPIRES_IN = '7d' (по умолчанию)
5. Создание verification code (email-верификация — заглушка)
6. return { token, user, message }
```

**Важно:** После регистрации сайтов у пользователя нет. Они появятся после подключения.

### 2.2 Вход → `POST /api/auth/login`

```
Клиент → auth-api: { email, password }
  ↓
1. findUserByEmail(email) — не найден → 401
2. verifyPassword(password, hash) — не совпал → 401
3. generateToken(user) → JWT
4. Загрузка сайтов:
   - admin → allSites() (дедупликация по URL)
   - client → findSitesByUser(user.id)
5. return { token, user, sites }
```

**Критически:** Если БД пуста или сайты не привязаны — пользователь залогинится, но увидит пустой список сайтов.

### 2.3 Привязка сайта (connect-code) — основной путь

```
Шаг A: WP Admin → AI Pilot → «Подключить сайт»
  ↓
WP Plugin: POST /wp-json/aipilot/v1/agent/connect-code
  ↓
1. Генерация токена: wp_generate_password(64, false)
   Сохраняется хеш: update_option('aipilot_api_token_hash', wp_hash(token))
   (токен в plain text — только в одноразовом response)
2. Генерация кода: wp_generate_password(8, false), TTL 5 минут
3. Хранение в aipilot_connect_codes[code] = { expires, token, site_url, site_name }
4. return { code, expires_in: 300 }

Шаг B: Человек копирует код в веб-чат
  ↓
Веб-чат → auth-api: POST /api/sites/connect-code { code, siteUrl }
  ↓
1. Проверка JWT (authGuard) — если 401 → «не входит»
2. fetch(url/wp-json/aipilot/v1/agent/verify-code?code=...)
   WP Plugin: проверяет code в aipilot_connect_codes
   - Не найден → 404
   - Просрочен (5 мин) → 410
   - Уже использован → 410 (used=true при первом verify)
3. WP возвращает { verified, site_url, site_name, token }
4. auth-api:
   - Если URL уже привязан к user → updateSiteToken() — ротация
   - Если нет → createSite()
5. notifyGateway(url, token, userId) — system event для Zero
6. return { id, url, name, verified }
```

### 2.4 Привязка сайта (direct connect) — запасной путь

```
auth-api: POST /api/sites/connect { url, apiToken, name? }
  ↓
1. Проверка JWT
2. Дубль URL у этого user? → 409
3. Верификация: fetch(url/wp-json/aipilot/v1/site, X-AI-Pilot-Token)
   - Если ok → извлекаем name + wp_version → verified=1
   - Если fail → создаём verified=0
4. createSite({ userId, url, name, apiToken, verified })
5. notifyGateway()
```

## 3. Хранение данных

### 3.1 SQLite (auth-api) — таблицы

| Таблица | Ключевые поля | Назначение |
|---------|---------------|------------|
| `users` | id, email, password_hash, name, role, email_verified | Пользователи |
| `sites` | id, user_id, url, api_token, verified | Привязка сайтов |
| `site_memory` | site_id, key, value, source | Кэш контекста |
| `chat_sessions` | user_id, site_id, title | Сессии чата |
| `messages` | session_id, role, content | Сообщения |
| `action_requests` | idempotency_key, action, status | Action proposals |
| `audit_events` | user_id, site_id, event_type | Аудит |
| `jobs` | site_id, type, status | Job queue |

### 3.2 WordPress (WP Plugin) — options

| Option key | Формат | Назначение |
|------------|--------|------------|
| `aipilot_api_token_hash` | строка (wp_hash) | Проверка токена — не plain text |
| `aipilot_connect_codes` | JSON { code → data } | Одноразовые коды подключения |
| `aipilot_site_id` | строка | Уникальный ID сайта |
| `aipilot_agent_soul` | JSON { tone_of_voice, rules } | ToV для агента |
| `aipilot_agent_memory` | JSON array | История обращений |
| `aipilot_agent_structure` | JSON | Кэш структуры (scan) |
| `aipilot_agent_proposals` | JSON { uuid → proposal } | Action proposals |
| `aipilot_api_capabilities` | JSON { cap → bool } | Права доступа |

## 4. Безопасность

### ✅ Хорошо
- **Токен хранится хешированно** — `wp_hash()` на WP, не plain text
- **Code одноразовый** — `used=true` блокирует повтор
- **JWT с expiry** — 7 дней, `jwt.verify()` валидирует exp
- **Аллоулист опций** — 17 ключей, защита от записи критичных опций
- **admin_email удалён** из структуры сайта (фикс 27.05)
- **DOMPurify** на v-html в HistoryPanel (фикс 27.05)

### ❌ Проблемы
- **token в plain text** на момент verify-code (возвращается в response, не логируется — это хорошо)
- **Нет rate limiting** на connect-code (можно перебирать коды)

## 5. Аудит уязвимостей (found in code review)

### 🚨 P1 — SQLite живёт внутри контейнера (DEPLOY RISK)

**Файл:** `src/db/connection.js`
```js
export const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'aipilot.db')
```

Если `DATABASE_PATH` не выставлен → БД в контейнере `/app/src/data/aipilot.db`. При `docker run` без volume — каждый деплой создаёт fresh empty DB.

**Симптом:** Пользователь зарегистрирован → deploy → БД пуста → "неверный email или пароль" → "опять не входит"

**Решение:** Проверить `DATABASE_PATH` в env контейнера, пробросить docker volume.

### 🚨 P2 — Восстановление из .migrated не гарантировано

**Файл:** `src/db/connection.js` (startup guard)
```js
if (userCount === 0) {
  // попытка восстановить из .migrated
}
```

Файл `.migrated` создаётся **один раз** при миграции с JSON на SQLite. Если deploy сносит volume — `.migrated` тоже нет. Startup guard пишет warning, но не восстанавливает данные.

**Симптом:** После deploy — все данные потеряны безвозвратно (если нет бэкапа).

### 🚨 P3 — JWT_SECRET может быть дефолтным

**Файл:** `src/config.js`
```js
JWT_SECRET: proces…CRET || 'dev-secret-change-in-production',
```

Если на сервере не задан `JWT_SECRET` — используется fallback. Опасно: если env меняется между деплоями, все токены становятся невалидны.

**Симптом:** Пользователь логинился, токен живёт 7 дней, deploy меняет env → токен протухает → "опять не входит".

### 🟡 P4 — Нет refresh token

JWT живёт 7 дней. После expiry — только logout/login. Нет `/auth/refresh`.

### 🟡 P5 — Email verification не реализован

**Файл:** `src/routes/auth.js`
```js
try { await sendVerificationEmail(email, code) } catch (err) { console.error('Email failed:', err.message) }
```

SMTP не настроен — `catch` молча глотает ошибку. Верификация есть только в схеме, не работает.

## 6. Схема «что проверить на сервере»

```bash
# 1. Проверить volume
docker inspect ai-pilot-auth | grep -A5 Mounts

# 2. Проверить переменные
docker exec ai-pilot-auth env | grep -E 'DATABASE_PATH|JWT_SECRET'

# 3. Проверить файл БД
docker exec ai-pilot-auth sh -c "ls -la /app/data/"

# 4. Проверить логи при старте
docker logs ai-pilot-auth 2>&1 | grep -E 'БД|DB|пользовател|migrated'

# 5. Проверить статус контейнера
docker compose ps
```

## 7. Вывод

**Самая вероятная причина «опять не входит»** — сброс SQLite БД при деплое.

Когда GitHub Actions пушит новый образ → `docker run` без `--volume` → старая БД не подхватывается → fresh empty DB → пользователь не может войти (email не найден) или входит с пустым списком сайтов.

**Рекомендации (по приоритету):**

1. **Закрепить volume** — пробросить папку `/app/data` как docker volume
2. **Проверить DATABASE_PATH** в env контейнера
3. **Добавить бэкап БД** — cron на хосте раз в час
4. **Добавить /auth/refresh** — для продления сессий без logout
5. **Настроить SMTP** — для реальной email-верификации
