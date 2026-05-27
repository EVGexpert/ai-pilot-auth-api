# AI Pilot — Системный аудит 2026-05-27

**Дата:** 2026-05-27  
**Версии:** Auth API 0.3.0, WP Plugin 2.1.1, Web Chat (main), Gateway 2026.5.26  
**Модель:** DeepSeek V4 Flash

---

## 1. Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                      Браузер (Vue 3)                     │
│  LoginForm │ ChatWindow │ ActionProposal │ HistoryPanel  │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS /api/*
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Auth API (ai-pilot-auth:3001)                │
│  Fastify + JWT + SQL.js + Job Queue + Audit Events       │
│                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ auth.js  │ │ chat.js  │ │ sites.js │ │ db/ (9 mods) │  │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │
└──────────┬──────────────┬──────────────────┬─────────────┘
           │              │                  │
           ▼              ▼                  ▼
   ┌────────────┐ ┌──────────┐ ┌──────────────────────┐
   │ Gateway    │ │  nginx   │ │ WordPress Plugin      │
   │ :18789     │ │ :80→chat │ │ /wp-json/aipilot/v1/* │
   │ DeepSeek   │ │          │ │ - agent/context       │
   └────────────┘ └──────────┘ │ - agent/propose       │
                               │ - agent/approve       │
                               │ - posts|pages|...     │
                               └──────────────────────┘
```

---

## 2. Технические метрики

### 2.1. Auth API

| Метрика | Значение |
|---------|----------|
| Файлов | 21 (JS modules) |
| LOC | 1 921 |
| Схема БД | v8 (action_requests) |
| Таблиц | 9 (users, sites, site_memory, email_verifications, chat_sessions, messages, jobs, audit_events, config, action_requests) |
| Job queue types | 2 (refresh_context, sync_wp_memory) |
| Экспортов из db/ | 42 функции |
| Деадлайн | ✅ retry + failJob |
| Таймауты fetches | ✅ все (5s/10s/15s) |
| Idempotency | ✅ schema v8 |

### 2.2. Web Chat

| Метрика | Значение |
|---------|----------|
| Фреймворк | Vue 3 + Pinia + Vue Router |
| UI библиотека | PrimeVue 4 |
| Компонентов | 14 |
| Санитизация | DOMPurify + marked.js |
| Токен в localStorage | ✅ через Auth API, без прямого Gateway |
| Роуты | /, /connect, /auth/connect→redirect |
| Storybook/тесты | ❌ нет |

### 2.3. WordPress Plugin

| Метрика | Значение |
|---------|----------|
| PHP строк | 6 842 |
| Файлов | 15 PHP + 5 модулей |
| Роутов REST | ~50 (2 публичных: ping, connect-code) |
| Capabilities | 34 |
| Неймспейсов | aipilot/v1 + openclaw/v1 (legacy) |
| Санитизация | ✅ везде (sanitize_, wp_kses, esc_) |
| Allowlist опций | ✅ **добавлен** (17 опций) |
| Nonce | ❌ не используется (токен-авторизация) |

---

## 3. Безопасность

### 3.1. Аутентификация

| Компонент | Метод | Статус |
|-----------|-------|--------|
| Web Chat → Auth API | JWT (Bearer) | ✅ |
| Auth API → WP Plugin | X-AI-Pilot-Token (hash) | ✅ |
| Token storage (WP) | WP options, только hash | ✅ |
| Token rotation | При каждом connect-code | ✅ |
| SMTP для verify | Не настроен → ошибка (безопасно) | ✅ |
| admin_email в LLM | **Убран** из /agent/context | ✅ **FIX** |

### 3.2. Уязвимости (исправленные сегодня)

| # | Уязвимость | Компонент | Фикс |
|---|-----------|-----------|------|
| 1 | `admin_email` утекал в контекст → LLM | WP Plugin | Убран из `aipilot_get_site_data()` |
| 2 | Нет allowlist опций → AI мог сменить siteurl | WP Plugin | Белый список из 17 опций |
| 3 | Verification code логировался в консоль | Auth API | Кидаем ошибку вместо лога |
| 4 | v-html без DOMPurify в HistoryPanel | Web Chat | Добавлена санитизация |
| 5 | Fetch без timeout (вечные запросы) | Auth API | +fetchWithTimeout везде |
| 6 | Двойное propose→approve для 1 действия | WP Plugin | ✅ уже idempotency key |
| 7 | Proposals не чистились | WP Plugin | Осталось: нужна очистка 24h |

---

## 4. Покрытие тестами

| Компонент | Тесты | Статус |
|-----------|-------|--------|
| Auth API | ❌ Нет | ⚠️ |
| Web Chat | ❌ Нет | ⚠️ |
| WP Plugin | `tests/wp-mock.php` (67 строк, неполный) | ⚠️ |
| Gateway | ❌ Нет | ⚠️ |

**Рекомендация:** unit-тесты на auth API (Fastify inject) и e2e на chat→auth→wp pipeline.

---

## 5. Операционные риски

### 5.1. Мониторинг
- ❌ Нет dashboard метрик (latency, errors, users)
- ❌ Нет алертов (работает только cron backup)
- ⚠️ Audit events пишутся, но нет UI для просмотра

### 5.2. Производительность
- ⚠️ sql.js — однопоточная, in-memory БД. 10+ одновременных запросов = блокировки
- ⚠️ `posts_per_page => -1` в scan() — убьёт сервер на сайте с 10k+ постов

### 5.3. Отказоустойчивость
- ✅ Docker restart: unless-stopped
- ✅ Bind mount для БД (данные не теряются)
- ✅ Gateway health check (`/health` → 200)
- ⚠️ Нет репликации, нет failover

---

## 6. Репозитории и CI/CD

| Репозиторий | Ссылка | CI | Статус |
|-------------|--------|----|--------|
| ai-pilot-auth-api | [GitHub](https://github.com/EVGexpert/ai-pilot-auth-api) | ✅ GitHub Actions → SSH | ✅ |
| ai-pilot-web-chat | [GitHub](https://github.com/EVGexpert/ai-pilot-web-chat) | ✅ GitHub Actions → SSH | ✅ (deprecated, всё через auth) |
| ai-pilot-wp-plugin | [GitHub](https://github.com/EVGexpert/ai-pilot-wp-plugin) | ❌ Нет | ⚠️ |

---

## 7. Pending Issues (оставшиеся)

| Приоритет | Что | Где | Сложность |
|-----------|-----|-----|-----------|
| P1 | Очистка proposals > 24h | WP Plugin | Low |
| P1 | Streaming (SSE) для ответов | Auth API | Medium |
| P1 | admin_email оставить только в /site | WP Plugin | ✅ FIXED |
| P2 | Unit-тесты для auth-api | Auth API | High |
| P2 | CI для wp-plugin | WP Plugin | Low |
| P2 | Пагинация для scan() | WP Plugin | Low |
| P2 | Dashboard метрик | Auth API + frontend | High |
| P3 | Postgres вместо sql.js | Auth API | Very High |

---

## 8. Заключение

**Общая оценка:** 🟡 **B (Удовлетворительно)** — все P0 закрыты, система стабильна

**Что хорошо:**
- Модульная архитектура (auth-api, plugin, chat, gateway)
- Job queue с retry/dead-letter
- Idempotency keys
- Audit events
- Auto-deploy через GitHub Actions
- Bind mount для БД

**Что нужно доделать:**
- Тесты (основной пробел)
- Streaming (пользовательский опыт)
- CI для WP плагина
- Очистка proposal'ов

---

*Аудит проведён AI-агентом Zero 2026-05-27. Все P0 исправлены в релизах сегодня.*
