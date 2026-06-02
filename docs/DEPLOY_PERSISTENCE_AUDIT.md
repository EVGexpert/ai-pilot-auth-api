# Deploy & Persistence Audit

> Дата: 2026-06-02
> Репозиторий: ai-pilot-auth-api

---

## Root Cause Summary

SQLite-БД (`aipilot.db`) хранится **внутри контейнера** по умолчанию (`./data/aipilot.db`).
Хотя deploy.yml передаёт volume и `DATABASE_PATH`, код не защищён от:

1. **Два разных default-пути** к БД (config.js vs connection.js)
2. **`docker rm -f`** без graceful stop — sql.js не успевает сохранить
3. **Post-deploy healthcheck сломан** — `/api/stats` требует admin JWT, deploy всегда видит `users=0`
4. **JWT_SECRET может быть пустым или dev-secret** в production
5. **Нет production guard** — без `DATABASE_PATH` приложение стартует с временным путём

---

## Таблица рисков

### P0 — потеря данных или невозможность входа

| # | Риск | Файл | Статус |
|---|------|------|--------|
| 1 | `docker rm -f` убивает контейнер без graceful stop → sql.js теряет данные | `.github/workflows/deploy.yml` | ❌ |
| 2 | Post-deploy healthcheck `curl /api/stats` всегда падает с 401 → ложный rollback | `.github/workflows/deploy.yml` | ❌ |
| 3 | При старте без `DATABASE_PATH` БД создаётся во временной директории → теряется после deploy | `src/db/connection.js` | ❌ |

### P1 — состояние может быть потеряно

| # | Риск | Файл | Статус |
|---|------|------|--------|
| 4 | `DATABASE_PATH` имеет два разных default-пути | `src/config.js`, `src/db/connection.js` | ❌ |
| 5 | `JWT_SECRET` может быть `dev-secret-change-in-production` в production | `src/config.js` | ❌ |
| 6 | Нет `NODE_ENV` → код не отличает production от dev | `Dockerfile`, `src/config.js` | ❌ |
| 7 | Backup делается до graceful stop, не после | `.github/workflows/deploy.yml` | ⚠️ |
| 8 | Нет атомарной записи БД (write → .tmp → rename) | `src/db/connection.js` | ❌ |

### P2 — UX и безопасность

| # | Риск | Файл | Статус |
|---|------|------|--------|
| 9 | Нет refresh token → любой deploy выкидывает всех пользователей | отсутствует | ❌ |
| 10 | Нет rate-limit для connect-code | `src/routes/sites.js` | ❌ |
| 11 | Нет логирования неудачных connect-code в audit_events | `src/routes/sites.js` | ❌ |
| 12 | Нет smoke-test на сохранность после рестарта | отсутствует | ❌ |

---

## Критерии успешной проверки

- [ ] `NODE_ENV=production` без `DATABASE_PATH` — приложение не стартует
- [ ] `NODE_ENV=production` без `JWT_SECRET` — приложение не стартует
- [ ] После `docker stop -t 30 && docker start` пользователь логинится
- [ ] После deploy с тем же volume пользователь логинится
- [ ] `curl /api/health/db -H "X-Deploy-Token: ..."` — возвращает users > 0
- [ ] `curl /api/stats` без Bearer — 401 (не используется в deploy)
- [ ] `scripts/db-health.js` — работает без сервера
- [ ] `scripts/smoke-persistence.sh` — создаёт → стопает → запускает → проверяет
