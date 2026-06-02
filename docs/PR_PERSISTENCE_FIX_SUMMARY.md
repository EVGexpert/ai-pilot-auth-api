# PR Summary: Persistence & Deploy Safety Fix

## Что было сломано

После деплоя через GitHub Actions пользователи теряли вход, сайты и историю чата.
SQLite-БД или сбрасывалась, или deploy не мог проверить её состояние.

**Root causes:**
1. `docker rm -f` убивал контейнер без graceful stop — sql.js не успевал сохранить данные
2. Post-deploy healthcheck использовал `/api/stats`, который всегда отвечает 401 без JWT — deploy ложно триггерил rollback
3. `DATABASE_PATH` имел два разных default-пути в config.js и connection.js
4. `JWT_SECRET` мог быть пустым или dev-secret в production

## Что изменено

### Persistence

| Изменение | Файл |
|-----------|------|
| Единый `DATABASE_PATH` из config.js | `src/config.js`, `src/db/connection.js` |
| Production guard: `DATABASE_PATH` обязателен | `src/config.js` |
| Production guard: защита от `/tmp`/`/src` путей | `src/config.js` |
| Production guard: `JWT_SECRET` обязателен + min 32 символа | `src/config.js` |
| Atomic write: `.tmp` → rename вместо прямой записи | `src/db/connection.js` |
| Dirty flag: save только при изменениях | `src/db/connection.js` |
| Graceful shutdown: SIGTERM → save → close | `src/db/connection.js` |
| Dockerfile: `ENV NODE_ENV=production`, `VOLUME /app/data` | `Dockerfile` |

### Deploy Flow

| Изменение | Файл |
|-----------|------|
| `docker stop -t 30` вместо `docker rm -f` | `.github/workflows/deploy.yml` |
| Backup после graceful stop (данные консистентны) | `.github/workflows/deploy.yml` |
| Healthcheck через `/api/health/db` (не /api/stats) | `.github/workflows/deploy.yml` |
| `/api/health/db` с `X-Deploy-Token` (без персональных данных) | `src/index.js` |
| Rollback при пустой БД с подтверждением | `.github/workflows/deploy.yml` |
| Понятный отчёт после деплоя | `.github/workflows/deploy.yml` |

### Security

| Изменение | Файл |
|-----------|------|
| Refresh-token flow (SHA256 hash, rotation) | `src/db/refresh_tokens.js`, `src/routes/auth.js` |
| `/api/auth/refresh` с token rotation | `src/routes/auth.js` |
| `/api/auth/logout` / `/api/auth/logout-all` | `src/routes/auth.js` |
| URL validation для connect-code | `src/routes/sites.js` |
| Per-IP rate limit для connect-code (5/min) | `src/routes/sites.js` |
| Audit events для failed connect-code | `src/routes/sites.js` |
| Better error codes: `code_invalid`, `wp_plugin_not_found` и др. | `src/routes/sites.js` |

### Testing

| Файл | Описание |
|------|----------|
| `scripts/db-health.js` | CLI-скрипт проверки БД без сервера |
| `scripts/smoke-persistence.sh` | E2E-тест: пользователь → рестарт → проверка |
| `scripts/regression-persistence.sh` | 7 regression-тестов |

## Затронутые файлы

```
.github/workflows/deploy.yml
Dockerfile
.env.example
package.json
src/config.js
src/db.js
src/db/index.js
src/db/connection.js
src/db/stats.js
src/db/refresh_tokens.js       (NEW)
src/index.js
src/routes/auth.js
src/routes/sites.js
scripts/db-health.js           (NEW)
scripts/smoke-persistence.sh   (NEW)
scripts/regression-persistence.sh  (NEW)
docs/DEPLOY_PERSISTENCE_AUDIT.md      (NEW)
docs/DOCKER_PERSISTENCE.md            (NEW)
docs/DEPLOY_HEALTHCHECK.md            (NEW)
docs/SECURITY_ENV.md                  (NEW)
docs/AUTH_REFRESH_FLOW.md             (NEW)
docs/CONNECT_CODE_SECURITY.md         (NEW)
docs/PERSISTENCE_SMOKE_TEST.md        (NEW)
docs/PR_PERSISTENCE_FIX_SUMMARY.md    (NEW)
```

## Как проверить локально

```bash
# 1. Production guards
NODE_ENV=production node -e "import('./src/config.js')"  # должен упасть
NODE_ENV=production DATABASE_PATH=/app/data/test.db node -e "import('./src/config.js')"  # должен упасть (нет JWT_SECRET)

# 2. Dev start
npm run dev

# 3. db-health.js
DATABASE_PATH=./data/aipilot.db node scripts/db-health.js

# 4. Regression tests
bash scripts/regression-persistence.sh

# 5. Smoke test (требует Docker)
docker build -t ai-pilot-auth .
bash scripts/smoke-persistence.sh
```

## Как проверить на сервере

```bash
# После деплоя:
# 1. Проверить, что старый пользователь логинится
curl -X POST https://pilotsite.ru/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin123@pilot.ru","password":"test123"}'

# 2. Проверить health/db
docker exec ai-pilot-auth sh -c '
  curl -H "X-Deploy-Token: $DEPLOY_HEALTH_TOKEN" http://localhost:3001/api/health/db
'
```

## Как откатиться

```bash
# 1. Остановить контейнер
docker stop -t 30 ai-pilot-auth

# 2. Восстановить БД из бэкапа
cp ~/ai-pilot-web-chat/auth-data/backups/<last-good>.db \
   ~/ai-pilot-web-chat/auth-data/aipilot.db

# 3. Запустить старый образ
docker run -d \
  --name ai-pilot-auth \
  -v ~/ai-pilot-web-chat/auth-data:/app/data \
  -e DATABASE_PATH=/app/data/aipilot.db \
  -e JWT_SECRET=<стабильный-secret> \
  ...старые параметры...
```

## Обязательные env/secrets

| Secret | Где задать | Зачем |
|--------|-----------|-------|
| `DATABASE_PATH` | Container env | `/app/data/aipilot.db` |
| `JWT_SECRET` | GitHub Secret + Container | Стабильный между деплоями |
| `DEPLOY_HEALTH_TOKEN` | GitHub Secret + Container | Для deploy healthcheck |
| `GATEWAY_TOKEN` | GitHub Secret + Container | Для связи с Gateway |

## Риски миграции

1. **JWT_SECRET при смене:** все существующие access token'ы станут невалидными. Нужно сохранять стабильный secret между деплоями.
2. **Refresh token rotation:** старые клиенты не используют refreshToken, продолжат работать со старым long-lived token (7d).
3. **Deploy healthcheck:** при первом деплое с новым deploy.yml нужно убедиться, что `DEPLOY_HEALTH_TOKEN` задан в GitHub Secrets.

## Checklist перед merge

- [ ] Все regression-тесты проходят
- [ ] JWT_SECRET стабильный (не менялся между тестовыми деплоями)
- [ ] DEPLOY_HEALTH_TOKEN добавлен в GitHub Secrets
- [ ] DOCKER volume подключён: `-v /root/ai-pilot-web-chat/auth-data:/app/data`
- [ ] Smoke-test пройден на целевой платформе
