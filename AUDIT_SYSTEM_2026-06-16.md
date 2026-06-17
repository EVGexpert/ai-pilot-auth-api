# 🔍 Полный аудит системы AI Pilot — 2026-06-16

> Файл создан для AI-агента. Содержит полную картину: архитектура, связи, поток данных, проблемы, уязвимости.

---

## 1. ОБЩАЯ АРХИТЕКТУРА (High-Level)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VPS (Калининград, GMT+2)                             │
│                                                                              │
│  GitHub ──push──► Docker Host ──► ┌──────────────────┐                      │
│  (Actions SSH)                    │  Caddy (80/443)   │                      │
│                                   │  pilotsite.ru     │                      │
│                                   │  chat.pilotsite.ru│                      │
│                                   └────────┬─────────┘                      │
│                                            │                                 │
│                   ┌────────────────────────┼──────────────────────┐         │
│                   ▼                        ▼                      ▼         │
│          ┌────────────────┐      ┌──────────────────┐  ┌─────────────────┐  │
│          │ OpenClaw       │      │ Web Chat (Vue 3) │  │ Auth API        │  │
│          │ Gateway        │      │ chat.pilotsite.ru│  │ (Fastify)       │  │
│          │ :18789         │      │ Nginx :3000      │  │ :3001           │  │
│          │ DeepSeek V4    │      │ SPA → /api/* →   │  │ SQLite (volume) │  │
│          └────────┬───────┘      │    → auth-api    │  └────────┬────────┘  │
│                   │              └──────────────────┘           │            │
│                   │   Docker network "aipilot"                  │            │
│                   └──────────────────┬──────────────────────────┘            │
│                                      ▼                                      │
│                         ┌──────────────────────┐                            │
│                         │  WordPress Plugin    │                            │
│                         │  (REST API v2.1.1)   │                            │
│                         │  obelisk.evgexpert.ru│                            │
│                         │  + другие сайты      │                            │
│                         └──────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. ПОТОК ДАННЫХ (Data Flow)

### 2.1 Сообщение от клиента до ответа AI

```
Клиент (браузер) → chat.pilotsite.ru (Vue 3 SPA)
  → POST /api/chat/send { message, siteUrl }
  → Auth API (:3001, Fastify)
    → Проверка JWT (authMiddleware)
    → Поиск site по user_id + siteUrl
    → Проверка api_token (не 'pending')
    → Создание/поиск chat_session
    → Получение/кэширование context с WP:
      GET /wp-json/aipilot/v1/agent/context
    → Сборка system prompt (CORE_RULES + GREETING_INSTRUCTION)
    → Формирование prefixedMessage: "[client:siteUrl] message"
    → Загрузка истории: последние 12 сообщений
    → POST /v1/chat/completions (к OpenClaw Gateway)
  → OpenClaw Gateway (:18789)
    → DeepSeek V4 Flash (или другой model)
    → Ответ с content + actions JSON
  → Auth API
    → Парсинг ```action ... ``` JSON
    → Сохранение user + assistant messages в SQLite
    → Создание фоновой задачи sync_wp_memory (POST на WP)
    → Ответ клиенту: { message, actions, sessionId }
  → Клиент (браузер) → отображение ответа + карточки действий
```

### 2.2 Подключение нового сайта

```
Клиент → WP Admin → AI Pilot Settings → Generate API Token
  → Генерируется 64-символьный токен → хранится как хеш
  → Token показывается один раз → клиент копирует

Клиент → chat.pilotsite.ru → Add Site
  → POST /api/sites/connect { url, apiToken }
  → Auth API → verify через /wp-json/aipilot/v1/site
  → Сохранить site в SQLite (user_id, url, name, api_token)
  → notifyGateway → POST /v1/chat/completions с [system:new-site]
```

**Альтернатива:** Connect Code (одноразовый код, 5 мин)

```
Клиент → WP Admin → "Get Connect Code"
  → Генерация 8-символьного кода + нового токена
  → Код показывается в админке
Клиент → chat.pilotsite.ru → вводит код
  → Auth API верифицирует через /wp-json/.../verify-code
  → Токен и URL передаются → site создаётся
```

### 2.3 Human-in-the-Loop (Action Proposal)

```
AI-агент (в ответе) → ```action { actions: [...] } ```
  → Auth API парсит → создаёт ActionProposal(id, type, target, patch)
  → Возвращает клиенту: { message, actions: [{id, title, diff}] }
  → Клиент видит карточку с diff → Approve / Reject
  → Approve:
    → POST /api/chat/actions/approve { actionId, action }
    → Idempotency key → проверка дубля
    → POST /wp-json/aipilot/v1/agent/propose (создать proposal на WP)
    → POST /wp-json/aipilot/v1/agent/approve/:id (выполнить)
    → Результат → клиенту
  → Reject:
    → POST /api/chat/actions/reject (только аудит, WP не трогаем)
```

### 2.4 Фоновые задачи

```
Auth API Job Queue (SQLite, таблица jobs):
  1. refresh_context — обновление кэша структуры сайта (GET /agent/context)
  2. sync_wp_memory — запись истории в память WordPress (POST /agent/memory)

Lifecycle:
  createJob() → status='pending'
  registerJobHandler(type, handler) → обработчик
  Обработчик выполняется асинхронно (нет worker pool!)
```

**⚠️ Проблема:** Хендлеры регистрируются, но нет цикла/воркера, который бы их выполнял. `createJob` только сохраняет задачу в БД. Нет кода, который бы брал задачи из очереди и запускал обработчики.

---

## 3. ИНФРАСТРУКТУРА

### 3.1 Docker контейнеры

| Контейнер | Образ | Порты | Сеть | Рестарт |
|-----------|-------|-------|------|---------|
| `ai-pilot-auth` | ai-pilot-auth | 127.0.0.1:3001→3001 | aipilot | unless-stopped |
| `ai-pilot-chat` | ai-pilot-chat | 127.0.0.1:3000→80 | aipilot | unless-stopped |
| `openclaw-gateway-1` | ghcr.io/openclaw/openclaw | 0.0.0.0:18789→18789 | default | - |

Все контейнеры с `--add-host host.docker.internal:host-gateway`

### 3.2 Точки входа (Caddy)

| Домен | Назначение | Прокси |
|-------|-----------|--------|
| `pilotsite.ru` | OpenClaw Gateway | Caddy → localhost:18789 |
| `chat.pilotsite.ru` | Веб-чат AI Pilot | Caddy → localhost:3000 |

### 3.3 Nginx (Web Chat)

```
chat.pilotsite.ru:443 (Caddy) → localhost:3000 (Nginx)
  /api/* → proxy_pass http://ai-pilot-auth:3001 (Docker DNS)
  /*     → SPA fallback (index.html)
  /assets/* → cache 1y
```

### 3.4 GitHub Actions Deploy

**auth-api** (`deploy.yml`, master):
1. SSH на сервер
2. **Backup БД** → `~/ai-pilot-web-chat/auth-data/backups/aipilot-pre-deploy-*.db`
3. `git clone` свежий код
4. `docker build -t ai-pilot-auth`
5. `docker rm -f` + `docker run` с volume `/root/ai-pilot-web-chat/auth-data:/app/data`
6. **Проверка БД** → `curl /api/stats` → если users=0 → восстановить из бэкапа
7. Prune образов

**web-chat** (`deploy.yml`, main):
1. SSH на сервер
2. `git stash` + `git pull`
3. `docker build -t ai-pilot-auth` (из auth-api/ папки!)
4. `docker build -t ai-pilot-chat`
5. `docker rm -f` обоих + `docker run`
6. Prune образов

---

## 4. БАЗА ДАННЫХ (SQLite)

### 4.1 Технический стек

- **Движок:** `sql.js` (WASM-эмуляция SQLite) — загружается из `node_modules/sql.js/dist/`
- **Файл:** `/app/data/aipilot.db` (точка монтирования: volume `auth-data`)
- **Путь:** `DATABASE_PATH` из env (по дефолту `./data/aipilot.db`)
- **WAL режим:** `PRAGMA journal_mode = WAL` (но sql.js не поддерживает WAL нативно!)
- **Сохранение:** debounce 1s + интервал 10s
- **Graceful shutdown:** save() на SIGINT/SIGTERM (через `close()`)

### 4.2 Схема (12 таблиц)

| Таблица | Назначение | Связи |
|---------|-----------|-------|
| users | Пользователи | PK id |
| sites | Подключённые сайты | FK user_id → users |
| email_verifications | Коды верификации email | FK user_id → users |
| chat_sessions | Сессии чата | FK user_id, site_id |
| messages | Сообщения в чатах | FK session_id → chat_sessions |
| jobs | Фоновая очередь задач | FK site_id, user_id, session_id |
| audit_events | Логи аудита | FK user_id, site_id, session_id |
| config | Настройки (key-value) | PK key |
| site_memory | Память по сайту | FK site_id, UNIQUE(site_id, key) |
| action_requests | Идемпотентные действия | UNIQUE idempotency_key |
| schema_version | Версия миграций | PK version |
| refresh_tokens | Refresh-токены | FK user_id |

### 4.3 Миграции (v1-v9)

v1: ALTER messages ADD COLUMN status  
v2: jobs table  
v3: audit_events table  
v4: config table  
v5: ALTER chat_sessions ADD COLUMN summary, summary_updated_at  
v6: ALTER sites ADD COLUMN cached_structure, cached_soul, cached_at, verified  
v7: site_memory table  
v8: action_requests table  
v9: refresh_tokens table (добавлена позже)

---

## 5. 🔴 КРИТИЧЕСКИЕ ПРОБЛЕМЫ (P0-P1)

### P0. Сброс БД при деплое — корневая причина

**Симптом:** После деплоя через GitHub Actions все пользователи пропадают (users=0).

**Причина №1 — sql.js ≠ SQLite:**
- `sql.js` — это WASM-эмуляция. Она не поддерживает WAL-режим нативно.
- При запуске: `PRAGMA journal_mode = WAL` — sql.js игнорирует эту директиву
- Но если предыдущая сессия была с нативным SQLite (Docker restart, другое приложение), остаются stale `-wal` и `-shm` файлы
- sql.js видит stale WAL → не может прочитать БД → создаёт пустую БД

**Причина №2 — `docker rm -f` без graceful shutdown:**
```bash
docker rm -f ai-pilot-auth 2>/dev/null || true
```
SIGKILL → SIGTERM не посылается → sql.js не успевает `save()` → потеря последних данных
(фикс: `docker stop -t 30` ждёт до 30s для graceful shutdown)

**Причина №3 — Разные DATABASE_PATH (историческая):**
- `connection.js` раньше имел свой fallback (`path.join(__dirname, '..', 'data', 'aipilot.db')`)
- `config.js` имел другой fallback (`'./data/aipilot.db'`)
- При запуске два инстанса могли писать в разные файлы
- ✅ Фикс: единый `DATABASE_PATH` из config.js

**Причина №4 — Deploy cleaning repo:**
```bash
rm -rf "$AUTH_DIR"  # web-chat deploy удаляет auth-api/
git stash --include-untracked  # старое стирает local changes
```
⚠️ Контейнеры пересобираются с нуля каждый деплой — нет гарантии, что volume не пересоздастся

### P1. Job Queue не работает

`registerJobHandler` регистрирует хендлеры, но нет воркера, который бы их запускал. Функции `refresh_context` и `sync_wp_memory` регистрируются при старте сервера в `chat.js`, но никогда не выполняются, потому что нет:
- Цикла `setInterval`, который берёт pending задачи
- Worker pool
- Обработчика `runJobs()`

**Последствия:**
- Кэш контекста сайта никогда не обновляется (только при первом запросе)
- Память сайта на WordPress никогда не синхронизируется
- Аудит есть, но фоновая работа не идёт

### P1. Гонка deploy.yml (web-chat)

В `web-chat/.github/workflows/deploy.yml`:
- `git stash --include-untracked` + `git clean -fd` на `~/ai-pilot-web-chat/`
- Собирает оба образа (`ai-pilot-auth` и `ai-pilot-chat`) из `auth-api/` и корня
- **Но:** при `git pull` может стереть auth-api/ папку, если она не часть репозитория
- JWT_SECRET хардкожен: `dev-jwt-secret-change-in-production`
- Нет backup/restore БД (в отличие от auth-api deploy.yml)
- Нет проверки БД после запуска

### P1. Безопасность — хардкоженные секреты в код-базе

| Файл | Что хардкожено | Риск |
|------|---------------|------|
| `web-chat/.github/workflows/deploy.yml` | `JWT_SECRET=dev-jwt-secret-change-in-production` | Средний — попало в публичный репозиторий |
| `web-chat/.github/workflows/deploy.yml` | `GATEWAY_TOKEN=f8186e8d77460...` (полный токен!) | **Высокий** — токен gateway в публичном репе |
| `sites.js` | Fallback `'f8186e8d77460...'` при `dev-gateway-token` | Средний — но если кто-то форкнет... |
| `chat.js` | Если `GATEWAY_TOKEN === 'dev-gateway-token'` → 500 | Маскирует отсутствие токена в GitHub Secrets |

---

## 6. ⚠️ ПРОБЛЕМЫ СРЕДНЕЙ ВАЖНОСТИ (P2-P3)

### P2. WordPress Plugin — дублирование эндпоинтов

- Один и тот же функционал определён в **двух местах**: `ai-pilot-plugin.php` (основной файл) и `module-agent.php` (отдельный модуль)
- `/agent/propose`, `/agent/approve`, `/agent/reject` — зарегистрированы дважды с разными callback
- `module-agent.php` использует числовой `id` (`(?P<id>\d+)`), а `ai-pilot-plugin.php` — UUID (`(?P<id>[a-f0-9-]+)`)
- `module-agent.php` хранит proposals как нумерованный массив (индекс = id), а `ai-pilot-plugin.php` — как ассоциативный (ключ = UUID)
- **Это конфликтующие реализации** — какой из них маршрутизируется первой, тот и отвечает

### P2. Нет graceful shutdown при деплое web-chat

```bash
docker rm -f ai-pilot-chat 2>/dev/null || true
docker rm -f ai-pilot-auth 2>/dev/null || true
```
SIGKILL → нет времени на `save()` → потеря данных. ✅ В auth-api deploy.yml исправлено используя `docker stop -t 30` → **нужно синхронизировать с web-chat deploy**.

### P2. Гонка при старте — notifyGateway может не успеть

При подключении сайта: `notifyGateway()` отправляет system event в Gateway. Но:
- Gateway может быть недоступен при старте контейнера
- Нет retry logic
- Нет подтверждения, что Zero обработал event
- Если event не дошёл, субагент создаётся только при первом сообщении `[client:URL]`

### P2. Парсинг действий — только строгий JSON

`parseStructuredActions()` ищет только ` ```action ... ``` ` или ` ```json ... ``` `
Если модель вернёт действия в другом формате — не распарсятся.
Эвристика была отключена намеренно, но это снижает надёжность.

### P2. Rate limiting — только /api/*

`@fastify/rate-limit` настроен на 20 запросов/мин на весь сервер.
Это нормально для разработки, но для продакшена нужно:
- Дифференцировать по ручкам (`/auth/login` должен быть строже)
- Использовать IP-based rate limiting
- Разделять per-route и global limits

### P3. Admin email утекает в контекст

`aipilot_get_site_data()` (в `module-agent.php`) возвращает `admin_email`:
```php
'site' => [
    ...
    'admin_email' => get_bloginfo('admin_email'),
],
```
Хотя в `ai-pilot-plugin.php` было убрано из `aipilot_get_site()`:
```php
'admin_email' => get_bloginfo('admin_email'),  // ⚠️ ВОЗВРАЩАЕТ admin_email!
```
**Проблема:** два файла, две реализации — одна убрала, другая нет.

### P3. Нет мониторинга

- Нет healthcheck endpointов для Docker (в Dockerfile нет HEALTHCHECK)
- Нет логирования в единую систему
- Нет алертов при падении БД
- Нет метрик (запросы/ошибки/латентность)

---

## 7. АРХИТЕКТУРНЫЕ ЗАМЕЧАНИЯ

### 7.1 sql.js vs нативный SQLite

**Текущее состояние:** `sql.js` (WASM) в Docker, `node:sqlite` (нативный) в MCP.
**Проблема:** Разные движки с разным поведением (WAL, персистентность).
**Рекомендация:** Перейти на `node:sqlite` (экспериментальный модуль Node 24) — он нативный, атомарный, без WASM-ограничений.

### 7.2 GitHub Actions deploy — shadow clone

**Сейчас:** `git clone --depth=1` свежий код каждый раз → компиляция в Docker.
**Риски:**
- Если GitHub недоступен — деплой не пройдёт
- `docker build` без кэша (каждый раз fresh clone)
- Нет версионирования образов (теги latest)

**Рекомендация:** Использовать Docker Registry (ghcr.io) с тегированными версиями.

### 7.3 Сеть Docker

- `aipilot` bridge network создаётся с `ip link delete docker0` (нестандартно)
- `host.docker.internal:host-gateway` добавлен всем контейнерам для связи с host (OpenClaw Gateway)
- Gateway обращается к auth-api через `http://ai-pilot-auth:3001`, но не наоборот — auth-api идёт к Gateway через `host.docker.internal:18789` или `GATEWAY_URL`

### 7.4 Single point of failure

- Один сервер (VPS, Калининград)
- Нет репликации БД
- Нет backup automation (только pre-deploy вручную)
- Все 3 контейнера на одном хосте → падение хоста = всё упало

---

## 8. СХЕМА КОММУНИКАЦИИ (Communication Matrix)

| FROM | TO | ПРОТОКОЛ | АУТЕНТИФИКАЦИЯ | ПОРТ |
|------|----|-----------|----------------|------|
| Caddy | Gateway | HTTP | Token (Bearer) | 18789 |
| Caddy | Web Chat | HTTP | Нет (SPA) | 3000 |
| Web Chat | Auth API | HTTP (CORS) | JWT (Bearer) | 3001 |
| Auth API | Gateway | HTTP | Gateway Token | 18789 |
| Auth API | WordPress | HTTP | X-AI-Pilot-Token | 443 |
| Auth API | SQLite | WASM (sql.js) | Нет (локальный) | — |
| WordPress | Auth API | HTTP (incoming) | X-AI-Pilot-Token | — |

---

## 9. ФАЙЛЫ И РЕПОЗИТОРИИ

### 9.1 Репозитории GitHub

| Репозиторий | Ветка CI | Версия |
|------------|----------|--------|
| `EVGexpert/ai-pilot-auth-api` | master ✅ | 0.3.0 |
| `EVGexpert/ai-pilot-web-chat` | main ✅ | 0.1.0 |
| `EVGexpert/ai-pilot-wp-plugin` | — ❌ | 2.1.1 |

### 9.2 WordPress Plugin — файловая структура

```
ai-pilot-plugin.php — main plugin file (REST API routes)
├── modules/
│   ├── module-agent.php         — /agent/*, структура, human-in-the-loop
│   ├── module-auth-helper.php   — AIPILOT_Fluent_Auth (deprecated)
│   ├── module-diagnostics.php   — /diagnostics
│   ├── module-media.php         — /media
│   └── modules-loader.php       — загрузчик модулей
├── src/
│   ├── Auth/Guard.php           — Verify token
│   ├── Core/Plugin.php          — Activation/deactivation
│   ├── Handlers/
│   │   ├── AdminHandler.php     — WP Admin страница настроек
│   │   ├── FluentCrmHandler.php — Conditional FluentCRM
│   │   ├── FluentSupportHandler.php — Conditional FluentSupport
│   │   └── SystemHandler.php    — Dynamic capability registration
│   └── class-admin.php          — Deprecated handler
├── tests/
│   └── wp-mock.php
└── uninstall.php
```

---

## 10. 🔧 КОНКРЕТНЫЕ ФИКСЫ (Action Items)

### Немедленно (P0)

1. **Перевести auth-api на node:sqlite** (как в MCP сервере) — убрать WAL-проблемы
2. **Добавить `docker stop -t 30`** в web-chat deploy.yml (вместо `docker rm -f`)
3. **Добавить SQLite WAL-cleanup** — удалять stale `-wal` и `-shm` при старте
4. **Убрать хардкоженные секреты из deploy.yml** → GitHub Secrets JWT_SECRET

### Важно (P1)

5. **Добавить job worker loop** — setInterval, берущий pending jobs из БД
6. **Удалить дубли WP endpoints** — оставить только `module-agent.php` ИЛИ `ai-pilot-plugin.php`
7. **Добавить HEALTHCHECK** в Dockerfile (curl /api/health)
8. **Добавить pre-deploy backup + integrity check** в web-chat deploy.yml

### Хорошо бы (P2)

9. **Убрать admin_email из структуры** в module-agent.php
10. **Добавить retry для notifyGateway** (3 попытки с интервалом)
11. **Добавить graceful shutdown обработчик** для auth-api (уже есть save, но проверить docker stop)
12. **Разделить rate limits** по маршрутам

---

## 11. ТЕКУЩИЕ МЕТРИКИ

*На момент аудита — неизвестно без запроса к API.*

**Проверить:**

```bash
# Проверка состояния Gateway
openclaw gateway status

# Проверка auth-api БД
curl http://localhost:3001/api/health

# Список контейнеров
docker ps

# Проверка состояния БД
curl -H "Authorization: Bearer $(openclaw token)" http://localhost:3001/api/stats
```

---

## 12. ВЫВОД

**Система работает, но хрупка.** Основная проблема — ДБ сбрасывается при деплое из-за комбинации:
1. `sql.js` несовместим с WAL → stale файлы блокируют чтение
2. `docker rm -f` убивает контейнер без graceful shutdown
3. Непоследовательные `DATABASE_PATH` (уже исправлено)
4. Нет pre-deploy backup в web-chat deploy.yml

**Вторая группа проблем** — WordPress Plugin имеет две конкурирующие реализации одних и тех же эндпоинтов, что может привести к непредсказуемому поведению.

**Третья группа** — секреты в открытом доступе (GATEWAY_TOKEN, JWT_SECRET хардкожены в deploy.yml на GitHub).

**Рекомендация:** провести спринт по фиксу P0-P1, затем перейти на node:sqlite, синхронизировать deploy.yml, почистить секреты и устранить дубли WP-плагина.

---

*Сгенерировано Zero 🎯 | 2026-06-16 21:48 UTC*

---

## 13. СТАТУС ВЫПОЛНЕНИЯ ПРОМПТОВ АРХИТЕКТОРА (2026-06-17)

В рамках аудита AI-архитектора (Арчи 🏗️) был составлен план из 9 промптов для трансформации системы из прототипа в production-ready платформу.

### Статус на 2026-06-17 09:30 UTC

| # | Промпт | Приоритет | Статус | Коммит |
|---|--------|-----------|--------|--------|
| 1 | SQLite → PostgreSQL | 🔴 Крит | ❌ Отложено | — |
| 2 | Worker scaling | 🔴 Крит | ❌ Отложено (зависит от #1) | — |
| 3 | Git leak secrets | 🔴 Крит | ✅ **Выполнено** | `5b17808` (web-chat), `1594e69` (auth-api) |
| 4 | Plugin JWT validation | 🔴 Крит | ✅ **Выполнено** | `54cab94` (wp-plugin) |
| 5 | Caddy healthcheck | 🟠 Выс | 🟡 **Частично** (health endpoint работает, Caddyfile — вручную) | — |
| 6 | WebSocket reconnect | 🟠 Выс | ✅ **Выполнено** | `c9edfde` (web-chat) |
| 7 | Graceful shutdown | 🟠 Выс | ✅ **Выполнено** | `954abf1` (auth-api) |
| 8 | Log aggregation | 🟡 Сред | ❌ Отложено | — |
| 9 | Multi-instance sync | 🟡 Сред | ❌ Отложено (зависит от #1) | — |

### Что сделано

#### PROMPT_03 — 🛡️ Секреты
- Убран хардкод `JWT_SECRET` и `GATEWAY_TOKEN` из `web-chat/.github/workflows/deploy.yml`
- Найден и исправлен дополнительный хардкод токена в `sites.js` (оба репозитория)
- Secrets вынесены в GitHub Secrets

#### PROMPT_04 — ✅ Plugin JWT Validation
- Полная JWT-валидация на стороне WordPress Plugin (нативная PHP, HS256)
- Проверка exp, iat, jti blacklist через transient
- Revoke endpoint `/auth/revoke`
- Логирование auth failures с IP и причиной
- 11/11 чек-лист пройден

#### PROMPT_06 — 🔌 WebSocket Reconnect
- Exponential backoff (1s, 2s, 4s… до 30s, 10 попыток)
- Message queue (сообщения не теряются при обрыве)
- Ack mechanism (timeout 10s → возврат в очередь)
- Event emitter паттерн
- Vue composable `useGatewayClient.js`
- Индикатор статуса подключения в ChatWindow.vue

#### PROMPT_07 — 💀 Graceful Shutdown
- SIGTERM/SIGINT → graceful shutdown: HTTP drain → DB save → exit(0)
- 30s force-exit timeout
- Memory monitor (каждые 30s, warning 80%, shutdown 95%)
- Dockerfile: `dumb-init` + `NODE_OPTIONS="--max-old-space-size=384 --expose-gc"`
- `/api/metrics` endpoint (admin only)

### Что ещё предстоит

| Промпт | Блокировка | План |
|--------|-----------|------|
| **#1 — PostgreSQL** | Нет | Фундамент для #2, #7, #9. Миграция sql.js → `node:sqlite` или PostgreSQL |
| **#5 — Caddyfile** | Нужен SSH | Добавить health checks в конфиг Caddy на сервере |
| **#2 — Worker** | #1 | Вынести worker в отдельный процесс Bull/Redis |
| **#8 — Logging** | #1, #2 | Единый trace ID через все сервисы |
| **#9 — Multi-instance** | #1, #2 | Shared PostgreSQL + Redis для сессий |

> **Zero 🎯:** Промпты архитектора выполняются последовательно. Сделанные фиксы уже повысили безопасность, надёжность и отказоустойчивость системы.
