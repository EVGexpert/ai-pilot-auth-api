# Security: Environment Variables

## Обязательные переменные (production)

| Переменная | Описание | Как сгенерировать |
|------------|----------|-------------------|
| `DATABASE_PATH` | Путь к SQLite-файлу (внутри volume) | `/app/data/aipilot.db` |
| `JWT_SECRET` | Секрет для подписи JWT (минимум 32 символа) | `openssl rand -hex 32` |
| `DEPLOY_HEALTH_TOKEN` | Токен для deploy healthcheck | `openssl rand -hex 32` |

## ⚠️ JWT_SECRET

**Критично:** JWT_SECRET должен быть **стабильным** между деплоями.
Если JWT_SECRET меняется — все существующие JWT-токены станут невалидными,
и все пользователи будут вынуждены залогиниться заново.

### Генерация

```bash
# Linux/macOS
openssl rand -hex 32

# Или через node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Проверка в deploy.yml (без вывода значения)

```yaml
- name: Verify secrets
  run: |
    if [ -z "${{ secrets.JWT_SECRET }}" ]; then
      echo "❌ JWT_SECRET is required"
      exit 1
    fi
    if [ ${#JWT_SECRET} -lt 32 ]; then
      echo "❌ JWT_SECRET must be at least 32 chars"
      exit 1
    fi
    echo "✅ JWT_SECRET present (${#JWT_SECRET} chars)"
```

> **Важно:** не выводите сам секрет в лог. Выводите только его длину.

## ⚠️ DEPLOY_HEALTH_TOKEN

Токен для `/api/health/db` endpoint. Передаётся в заголовке `X-Deploy-Token`.
Без него deploy не сможет проверить целостность БД после деплоя.

## Чего не должно быть в production

- `dev-secret-change-in-production` (JWT_SECRET)
- `dev-gateway-token` (GATEWAY_TOKEN)
- `DATABASE_PATH` внутри `/tmp`, `/src`, `/dev/shm`

## GitHub Secrets

| Secret | Где используется |
|--------|-----------------|
| `DEPLOY_HOST` | SSH target |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | SSH private key |
| `JWT_SECRET` | Container env (deploy.yml) |
| `DEPLOY_HEALTH_TOKEN` | Container env (deploy.yml) |
| `GATEWAY_TOKEN` | Container env (deploy.yml) |
