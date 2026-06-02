# Deploy Healthcheck

## HTTP Endpoint: `/api/health/db`

Безопасный endpoint для проверки целостности БД после деплоя.
Не возвращает персональные данные (email, пароли, токены, сообщения).

### Требования

Обязательный заголовок: `X-Deploy-Token`

### Пример

```bash
curl -sf \
  -H "X-Deploy-Token: production-token" \
  http://localhost:3001/api/health/db
```

### Ответ

```json
{
  "status": "ok",
  "databasePath": "/app/data/aipilot.db",
  "databaseExists": true,
  "databaseSizeBytes": 123456,
  "users": 10,
  "sites": 3,
  "sessions": 15,
  "messages": 150,
  "schemaVersion": 8
}
```

### Ошибки

| Код | Причина |
|-----|---------|
| 401 | Missing X-Deploy-Token |
| 403 | Invalid deploy token |
| 503 | DEPLOY_HEALTH_TOKEN not configured in production |
| 500 | DB read error |

---

## CLI Script: `scripts/db-health.js`

Альтернативная проверка БД без запуска HTTP-сервера.

### Использование

```bash
node scripts/db-health.js
# или с указанием пути
DATABASE_PATH=/app/data/aipilot.db node scripts/db-health.js
```

### Через Docker

```bash
docker run --rm \
  -e DATABASE_PATH=/app/data/aipilot.db \
  -v /root/ai-pilot-web-chat/auth-data:/app/data \
  ai-pilot-auth npm run db:health
```

### Exit codes

- `0` — БД читается (даже если пустая)
- `1` — БД повреждена или не читается

---

## Использование в deploy.yml

```yaml
# Через HTTP endpoint (рекомендуется)
DB_CHECK=$(docker exec "$CONTAINER_NAME" sh -c '
  TOKEN=${DEPLOY_HEALTH_TOKEN:-deploy}
  curl -sf -H "X-Deploy-Token: $TOKEN" http://localhost:3001/api/health/db
')

# Через CLI-скрипт (без HTTP)
DB_CHECK=$(docker exec "$CONTAINER_NAME" npm run db:health 2>/dev/null || echo '{"status":"error"}')
```

---

## Настройка

1. Сгенерировать токен: `openssl rand -hex 32`
2. Добавить в GitHub Secrets: `DEPLOY_HEALTH_TOKEN`
3. Передать в контейнер: `-e DEPLOY_HEALTH_TOKEN=${{ secrets.DEPLOY_HEALTH_TOKEN }}`
