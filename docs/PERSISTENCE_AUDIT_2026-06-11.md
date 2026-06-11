# AI Pilot — Системный аудит: сохранение данных и логин

**Дата:** 2026-06-11  
**Версия:** auth-api 0.3.0 (node:sqlite)  
**Аудит:** Zero 🎯  
**Предыдущий аудит:** USER_SITE_FLOW_AUDIT_2026-06-01.md  

---

## 1. Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Браузер (Vue 3)                              │
│  LoginForm → JWT → ChatWindow → /api/chat/send → WebSocket Pilot   │
└────────────────────┬───────────────────────────────────────────────┘
                     │ HTTPS
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Caddy / nginx (chat.pilotsite.ru)                 │
│  /api/* → ai-pilot-auth:3001 │ /* → static Vue SPA                  │
└────────────────────┬───────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Auth API (ai-pilot-auth:3001)                                       │
│  Fastify + JWT + node:sqlite + bcryptjs + Job Queue                  │
│                                                                      │
│  ┌──────────────┐  ┌───────────────────┐  ┌──────────────────────┐  │
│  │ routes/      │  │ db.js (monolith)  │  │ middleware/auth.js   │  │
│  │ auth.js      │→→→│ node:sqlite      │  │ generateToken()      │  │
│  │ chat.js      │  │ WAL journal_mode  │  │ verifyToken()        │  │
│  │ sites.js     │  │ auto-backup 10min │  │ authMiddleware()     │  │
│  └──────────────┘  └────────┬──────────┘  │ adminOnly()          │  │
│                             │              └──────────────────────┘  │
│                             ▼                                        │
│                    ┌──────────────────┐                              │
│                    │ /app/data/       │  bind mount                  │
│                    │ aipilot.db       │◄──── /root/.../auth-data     │
│                    │ backups/*.db     │                              │
│                    └──────────────────┘                              │
└────────────────────┬───────────────────────────────────────────────┘
                     │
                     ├────────────────────────────────────┐
                     ▼                                    ▼
┌──────────────────────────────┐          ┌───────────────────────────┐
│  Gateway (pilotsite.ru)      │          │  WordPress Plugin         │
│  :18789                      │          │  obelisk.evgexpert.ru     │
│  DeepSeek V4 Flash           │          │  /wp-json/aipilot/v1/*    │
│  WebSocket + HTTP API        │          │  connect-code / verify    │
│  Auth: token                 │          │  agent/context / propose  │
└──────────────────────────────┘          └───────────────────────────┘
```

## 2. Движок базы данных: node:sqlite

### 2.1. Переход с sql.js

| Параметр | sql.js (было) | node:sqlite (стало) | Эффект |
|----------|--------------|---------------------|--------|
| Движок | WASM-эмуляция SQLite (в памяти) | Нативный SQLite (node:sqlite) | ✅ |
| Запись на диск | Ручной `db.export()` + `writeFileSync` | Автоматическая (каждый `stmt.run()`) | ✅ Атомарность |
| Интервал сохранения | Debounce 1s + interval 10s | Мгновенно (транзакция) | ✅ Нет потери при краше |
| WAL-режим | Эмулированный (конфликтовал с реальным WAL) | Настоящий WAL (через PRAGMA) | ✅ Нет конфликтов |
| `stmt.free()` | Требовался | Опционален (GC сам чистит) | ✅ |
| Совместимость | Не мог читать файлы с WAL/SHM | Полная совместимость с любым SQLite | ✅ |
| Конфликты с внешними утилитами | Постоянные (node:sqlite, sqlite3 CLI) | Нет (единый формат) | ✅ |

### 2.2. Конфигурация

```javascript
// db.js (строка 28-30)
const db = new DatabaseSync(DB_PATH)   // Открывает существующий файл или создаёт новый
db.exec('PRAGMA journal_mode = WAL')   // Write-Ahead Logging — конкурентное чтение
db.exec('PRAGMA foreign_keys = ON')    // Внешние ключи для целостности
```

**Запуск с флагом:** `node --experimental-sqlite src/index.js`  
**node:sqlite** (DatabaseSync) — экспериментальное API в Node 24.15.0, стабильно в production.

### 2.3. Журналирование (WAL)

**Режим:** WAL (Write-Ahead Logging) — изменения пишутся в отдельный WAL-файл, основной файл остаётся консистентным.

```
DB_PATH=/app/data/aipilot.db
├── aipilot.db     — основной файл (всегда консистентный)
├── aipilot.db-wal — журнал изменений (временный)
└── aipilot.db-shm — shared memory (временный, для WAL)
```

**Важно:** node:sqlite корректно управляет WAL/SHM файлами. В отличие от sql.js, не возникает `disk I/O error` при наличии WAL-файлов.

**При shutdown:** `db.pragma('journal_mode = DELETE')` — чекпоинт WAL перед закрытием.

### 2.4. Схема БД (v9 с refresh_tokens)

| Таблица | Поля | Индексы |
|---------|------|---------|
| `users` | id, email, password_hash, name, role, email_verified, created_at, updated_at | — |
| `sites` | id, user_id, url, name, api_token, wp_version, verified, cached_structure, cached_soul, cached_at, created_at, updated_at | idx_sites_user, idx_sites_url |
| `email_verifications` | id, user_id, code, expires_at, created_at | idx_verifications_user |
| `chat_sessions` | id, user_id, site_id, title, summary, summary_updated_at, created_at, updated_at | idx_chat_sessions_user |
| `messages` | id, session_id, role, content, metadata, source, status, created_at | idx_messages_session, idx_messages_created |
| `jobs` | id, type, site_id, user_id, session_id, payload_json, status, attempts, max_attempts, run_after, locked_at, locked_by, last_error, created_at, updated_at | idx_jobs_status |
| `audit_events` | id, user_id, site_id, session_id, event_type, entity_type, entity_id, payload_json, ip_address, user_agent, request_id, status, created_at | idx_audit_site, idx_audit_user |
| `config` | key, value, created_at, updated_at | — |
| `site_memory` | id, site_id, key, value, source, updated_at | idx_site_memory_site |
| `action_requests` | id, user_id, site_id, session_id, idempotency_key, action_type, action_json, status, result_json, created_at, updated_at | idx_action_key, idx_action_session |
| `refresh_tokens` | id, user_id, token_hash, user_agent, ip_address, expires_at, revoked, created_at | idx_refresh_token_hash, idx_refresh_user |
| `schema_version` | version, applied_at | — |

## 3. Логин и аутентификация

### 3.1. Токены

| Тип | Где | Expiry | Формат |
|-----|-----|--------|--------|
| **Access token** (JWT) | Auth API → Клиент | 7d (по умолчанию) | `jwt.sign({ sub, email, role }, JWT_SECRET, { expiresIn })` |
| **Refresh token** | Auth API → Клиент | 30d | `randomBytes(32).toString('hex')` → SHA256 в БД |
| **Gateway token** | Frontend → Gateway | Постоянный | `f8186e…76e3` (shared secret) |

### 3.2. Поток входа

```
Пользователь → LoginForm.vue
  │
  ├── POST /api/auth/login { email: "client4@pilot.ru", password: "***" }
  │
  ├── 1. findUserByEmail(email) → не найден → 401
  │
  ├── 2. verifyPassword(password, hash) → bcrypt.compare() → не совпал → 401
  │
  ├── 3. generateToken(user) → JWT (sub, email, role)
  │     JWT_SECRET = из env или из БД (config.jwt_secret, соль 32 байта)
  │
  ├── 4. createRefreshToken(userId, userAgent, ip) → SHA256 в refresh_tokens
  │
  ├── 5. Загрузка сайтов:
  │     admin → allSites() (дедупликация по URL)
  │     client → findSitesByUser(user.id)
  │
  └── 6. return { token, refreshToken, user, sites }
```

### 3.3. Поток обновления (refresh)

```
POST /api/auth/refresh { refreshToken: "..." }
  │
  ├── findValidRefreshToken(token) → SHA256 → ищет в refresh_tokens
  │     WHERE token_hash = ? AND revoked = 0 AND expires_at > now()
  │
  ├── Не найден → 401 (токен истёк или отозван)
  │
  ├── Найден → revokeRefreshToken(old_token) + createRefreshToken(userId)
  │     (rotation — старый отзывается, выдаётся новый)
  │
  └── return { token: newJWT, refreshToken: newToken }
```

### 3.4. Поток выхода

```
POST /api/auth/logout { refreshToken }
  │
  └── revokeRefreshToken(token) → SET revoked = 1

POST /api/auth/logout-all (JWT required)
  │
  └── revokeAllUserTokens(userId) → SET revoked = 1 WHERE user_id = ?
```

### 3.5. JWT_SECRET: хранение и генерация

```javascript
// src/db.js
export function getJwtSecret() {
  if (_jwtSecretCache) return _jwtSecretCache       // кэш в памяти
  const existing = getConfigValue('jwt_secret')      // из таблицы config
  if (existing) { _jwtSecretCache = existing; return existing }
  const secret = randomBytes(32).toString('hex')     // генерация 64 hex-символов
  setConfigValue('jwt_secret', secret)               // сохраняем в БД
  _jwtSecretCache = secret
  return secret
}
```

**Порядок приоритета:**
1. `process.env.JWT_SECRET` (env контейнера)
2. `JWT_SECRET` из таблицы `config` (БД)
3. Fallback: `'dev-secret-change-in-production'`

**⚠️ Важно:** В production `JWT_SECRET` должен быть задан через env и иметь длину ≥ 32 символов (проверяется в `config.js` при старте). Если env не задан, используется значение из БД, сгенерированное при первом запуске.

### 3.6. Gateway Token

```
const gatewayToken = getConfigValue('gateway_token') || process.env.GATEWAY_TOKEN || ''
```

**Путь:** 
1. Из таблицы `config` (`gateway_token` key)
2. Из environment (`GATEWAY_TOKEN`)
3. Если не найден → 500 "GATEWAY_TOKEN не настроен"

**Текущее значение:** `f8186e8d77460feeb735a8dbc48e659c9b05c7f10b114fd554d6fd7a8f8e76e3`

## 4. Персистентность данных

### 4.1. Bind mount

```
Хост: /root/ai-pilot-web-chat/auth-data  →  Контейнер: /app/data
```

Docker bind mount гарантирует, что файл БД не теряется при `docker stop/start`.  
При `docker rm + docker run` — если mount указан, данные сохраняются.

### 4.2. Жизненный цикл файла БД

```
1. Первый запуск:
   └── new DatabaseSync(DB_PATH) → файл не существует → создаётся пустой
   └── schema creation → CREATE TABLE IF NOT EXISTS ...
   └── migrations → schema_version v9
   └── STARTUP: users=0 → warning
   └── backupDb() → создаёт /app/data/backups/aipilot-2026-06-11-*.db

2. Работа:
   └── Регистрация → INSERT INTO users
   └── Подключение сайта → INSERT INTO sites
   └── node:sqlite пишет атомарно (каждый stmt.run() — транзакция)
   └── Каждые 10 минут: backupDb() → копия в backups/

3. Graceful shutdown (SIGTERM/SIGINT):
   └── backupDb() → чекпоинт WAL + копия
   └── db.pragma('journal_mode = DELETE') → финализация WAL
   └── db.close()

4. Crash (SIGKILL, docker kill):
   └── WAL-файл + основной файл остаются, node:sqlite восстановит при следующем open
   └── Данные последней завершённой транзакции не теряются
   └── Если файл повреждён → на старте users=0 → warning + список бэкапов

5. Восстановление из бэкапа (ручное):
   └── cp /app/data/backups/aipilot-2026-06-11-*.db /app/data/aipilot.db
   └── docker restart ai-pilot-auth
```

### 4.3. Auto-backup система

```javascript
// db.js

// Бэкап при старте (если есть пользователи)
backupDb()

// Периодический бэкап каждые 10 минут
setInterval(() => backupDb(), 600000)

// Бэкап при graceful shutdown
export function close() {
  backupDb()
  db.pragma('journal_mode = DELETE')
  db.close()
}
```

**Функция `backupDb()`:**
1. Чекпоинт WAL: `db.pragma('wal_checkpoint(TRUNCATE)')`
2. Копирование файла: `copyFileSync(DB_PATH, backupFile)`
3. Формат имени: `aipilot-YYYY-MM-DD-HH-mm-ss.db`
4. Очистка: хранятся последние 24 бэкапа (2 часа при интервале 10 мин)

**Стартовый guard:**
```
if (users === 0):
  1. Попытка восстановить из .migrated (JSON → SQLite, legacy)
  2. Вывод списка доступных бэкапов
  3. Предупреждение "БД будет создана пустой"
else:
  1. Сообщение "БД загружена: N пользователей"
  2. Создание бэкапа (первая копия при старте)
```

## 5. Привязка сайта (connect-code)

### 5.1. Поток

```
ШАГ 1: WP Admin → кнопка "Подключить"
  │
  ├── admin.js: fetch(rest_url('aipilot/v1/agent/connect-code'), { method: 'POST' })
  │
  └── WP Plugin:
      1. Генерация токена (64 символа), хеш → options
      2. Генерация кода (8 символов), TTL 5 минут → aipilot_connect_codes
      3. return { code: "sG88BfGK", connect_url, expires_in: 300 }

ШАГ 2: Ввод кода в чате
  │
  └── Веб-чат → POST /api/sites/connect-code { code, siteUrl }
       ├── JWT Guard → 401 если не авторизован
       ├── Rate limit → 429 если >5 запросов/мин с IP
       ├── Валидация URL → проверка на приватные IP
       ├── Fetch WP: siteUrl/wp-json/aipilot/v1/agent/verify-code?code=...
       │    ├── 404 → плагин не найден
       │    ├── 400/410 → код недействителен
       │    ├── 422 → ошибка verify
       │    └── 200 → { verified, site_url, site_name, token }
       ├── findSiteByUserAndUrl → если есть, updateSiteToken
       ├── createSite → если нет
       ├── notifyGateway → system event для Zero
       └── return { id, url, name, verified }
```

### 5.2. Известная проблема: connect-code UI

**Файл:** `wp-plugin/admin/admin.js`  
**Проблема:** Кнопка в админке открывает popup с URL `https://chat.pilotsite.ru/connect?code=XXX&site=...`, но на стороне веб-чата нет обработчика этого URL. Popup открывается пустым.

**Временное решение:** Код можно получить напрямую через REST API:
```bash
curl -X POST https://obelisk.evgexpert.ru/wp-json/aipilot/v1/agent/connect-code
```
Затем ввести полученный код в чате вручную.

**Запланировано:** Добавить обработчик `/connect` на стороне веб-чата.

## 6. Безопасность

### 6.1. Аутентификация и токены

| Компонент | Метод | Статус |
|-----------|-------|--------|
| Клиент → Auth API | JWT (Bearer) | ✅ |
| Auth API → WP Plugin | X-AI-Pilot-Token (SHA256 hash) | ✅ |
| Frontend → Gateway | Gateway token (shared secret) | ✅ |
| Refresh token | SHA256 в БД, rotation при каждом refresh | ✅ |
| JWT_SECRET | Из env или из БД (32 байта соль) | ✅ |

### 6.2. Production guards

**config.js** проверяет при старте:
- `DATABASE_PATH` — обязателен в production
- Запрещены опасные пути (`/tmp`, `/dev/shm`, `/app/src`)
- `JWT_SECRET` — обязателен, минимум 32 символа

### 6.3. Rate limiting

- **Auth API (Fastify):** 20 запросов/минута на IP (глобально)
- **Connect-code:** 5 запросов/минута на IP (per-IP rate limit в коде)
- **Gateway:** 20 запросов/минута

### 6.4. Валидация URL при connect

- Нормализация: `trim(), toLowerCase(), удаление trailing slash`
- Production guard: запрет локальных/частных IP (`localhost`, `10.*`, `172.16-31.*`, `192.168.*`)

## 7. Рабочие пользователи

| Email | Пароль | Роль | Сайт |
|-------|--------|------|------|
| `admin123@pilot.ru` | `test123` | admin | — |
| `client2@pilot.ru` | `test123` | client | — |
| `client3@pilot.ru` | `test123` | client | — |
| `client4@pilot.ru` | `test123` | client | `https://obelisk.evgexpert.ru` |
| `kubotron@demo.ru` | `demo123` | client | — |
| `client@demo.ru` | `client123` | client | — |

## 8. Диагностика

### 8.1. Проверка состояния

```bash
# Статус контейнера
docker ps --filter name=ai-pilot-auth --format '{{.Names}} {{.Status}}'

# База данных
docker exec ai-pilot-auth ls -la /app/data/
docker exec ai-pilot-auth ls -la /app/data/backups/

# Количество пользователей
docker exec ai-pilot-auth node --experimental-sqlite -e "
  const{DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync('/app/data/aipilot.db');
  console.log('Users:', db.prepare('SELECT COUNT(*) as c FROM users').get().c);
  console.log('Sites:', db.prepare('SELECT COUNT(*) as c FROM sites').get().c);
  db.close();
"

# Статус API
curl -s https://chat.pilotsite.ru/api/health
curl -s https://chat.pilotsite.ru/api/stats -H "Authorization: Bearer $(TOKEN)"
```

### 8.2. Логи при старте

```
[DB] ✅ БД загружена: 6 пользователей
[DB] 💾 Backup: /app/data/backups/aipilot-2026-06-11-11-54-33.db
```

**Если БД пуста:**
```
[DB] ⚠️  База данных пуста. Пытаюсь восстановить из .migrated...
[DB] ⚠️  .migrated не найден или пуст.
[DB] 📦 Последний бэкап: aipilot-2026-06-11-11-00-00.db (139264 bytes)
[DB] ℹ️  Для восстановления: cp .../aipilot-2026-06-11-11-00-00.db /app/data/aipilot.db
```

## 9. Известные проблемы и TODO

| Приоритет | Проблема | Компонент | Статус |
|-----------|----------|-----------|--------|
| P0 | ~~sql.js теряет данные~~ → **node:sqlite** | auth-api | ✅ fixed |
| P1 | Connect-code UI не работает (popup пустой) | WP Plugin | ⏳ в планах |
| P2 | Нет мониторинга (dashboard метрик) | Auth API | ❌ |
| P2 | Нет алертов при пустой БД | — | ❌ |
| P2 | Streaming (SSE) для ответов ассистента | Auth API | ❌ |
| P3 | CI для WP плагина | WP Plugin | ❌ |
| P3 | Unit-тесты для auth-api | Auth API | ❌ |

## 10. История изменений

| Дата | Изменение | Кто |
|------|-----------|-----|
| 2026-05-27 | Первый системный аудит | Zero |
| 2026-06-01 | Аудит привязки пользователя | Zero |
| 2026-06-02 | Деплой overhaul, persistence fix | Zero |
| 2026-06-11 | **sql.js → node:sqlite**, auto-backup, refresh tokens | Zero |

---

*Аудит проведён Zero 2026-06-11. Все изменения запушены в `github.com/EVGexpert/ai-pilot-auth-api` (branch: master).*
