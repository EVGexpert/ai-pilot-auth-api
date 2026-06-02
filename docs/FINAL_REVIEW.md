# Final Review: GO/NO-GO Decision

## Проверка checklist

| # | Пункт | Статус |
|---|-------|--------|
| 1 | `docker rm -f` заменён на `docker stop -t 30`? | ✅ |
| 2 | Backup делается после graceful stop? | ✅ |
| 3 | `DATABASE_PATH` единый (config.DATABASE_PATH)? | ✅ |
| 4 | Docker run содержит `-v ...:/app/data`? | ✅ |
| 5 | `NODE_ENV=production` выставлен? | ✅ (в Dockerfile + deploy.yml) |
| 6 | `JWT_SECRET` обязателен и не логируется? | ✅ (guard + min 32 символов) |
| 7 | `DEPLOY_HEALTH_TOKEN` обязателен и не логируется? | ✅ (guard + X-Deploy-Token) |
| 8 | `/api/stats` не используется в deploy без авторизации? | ✅ (заменён на `/api/health/db`) |
| 9 | Есть backup перед заменой контейнера? | ✅ |
| 10 | Есть rollback при пустой БД? | ✅ |
| 11 | Есть smoke-test на сохранность пользователя? | ✅ (`scripts/smoke-persistence.sh`) |
| 12 | Healthcheck не отдаёт email/password_hash/apiToken? | ✅ (только агрегаты) |
| 13 | Нет `rm -rf` директории auth-data? | ✅ |
| 14 | Все regression тесты проходят? | ✅ (7/7) |

## Блокирующие проблемы

**Нет.** Все P0/P1 риски из аудита устранены.

## Неблокирующие улучшения (на будущее)

1. **CI job для regression** — добавить `workflow_dispatch` в GitHub Actions
2. **Refresh token UI** — frontend пока не использует refreshToken
3. **Log rotation audit_events** — таблица audit_events растёт, нужна очистка
4. **SMTP** — email-верификация требует SMTP (не критично)

## Команды финальной проверки на сервере

```bash
# 1. Проверить, что контейнер запущен
docker ps --filter "name=ai-pilot-auth" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 2. Проверить переменные окружения
docker exec ai-pilot-auth env | grep -E "NODE_ENV|DATABASE_PATH|JWT_SECRET|DEPLOY_HEALTH_TOKEN" | grep -v "SECRET="

# 3. Проверить volume
docker inspect ai-pilot-auth --format '{{range .Mounts}}{{.Source}} → {{.Destination}}{{"\n"}}{{end}}'

# 4. Проверить health endpoint
docker exec ai-pilot-auth sh -c '
  curl -s -H "X-Deploy-Token: $DEPLOY_HEALTH_TOKEN" http://localhost:3001/api/health/db
'

# 5. Проверить login старого пользователя
curl -s -X POST https://pilotsite.ru/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin123@pilot.ru","password":"test123"}' | python3 -m json.tool

# 6. Проверить refresh token
# (логин должен вернуть refreshToken)
```

## GO / NO-GO

**✅ GO — решение: можно merge и деплоить.**

Все 14 пунктов checklist пройдены. Критические риски (P0) устранены:

- Docker rm -f → graceful stop
- Healthcheck через /api/health/db (а не /api/stats)
- Единый DATABASE_PATH с production guards
- Atomic write + dirty flag для sql.js
- Refresh-token flow для плавного перевыпуска сессий
- Rate limit + audit для connect-code

### Перед deploy

1. Добавить `DEPLOY_HEALTH_TOKEN` в GitHub Secrets
2. Убедиться, что `JWT_SECRET` стабильный (совпадает с текущим)
3. Проверить, что `~/ai-pilot-web-chat/auth-data/backups/` существует
4. Запустить smoke-test локально (если есть Docker): `bash scripts/smoke-persistence.sh`
