# Docker Persistence for SQLite

## ⚠️ Важное предупреждение

**VOLUME в Dockerfile не заменяет явный volume при запуске!**

Без явного `-v` или `--mount` Docker создаст анонимный volume, который:
- будет удалён после `docker rm -v`
- не будет переиспользован следующим `docker run`

**Для production всегда используйте bind mount или named volume.**

---

## Примеры запуска

### Named volume (рекомендуется для development)

```bash
docker volume create ai-pilot-auth-data
docker run -d \
  --name ai-pilot-auth \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v ai-pilot-auth-data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  ai-pilot-auth
```

### Bind mount (рекомендуется для production)

```bash
docker run -d \
  --name ai-pilot-auth \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -v /host/path/to/auth-data:/app/data \
  -e JWT_SECRET="production-secret-32chars-min" \
  -e DATABASE_PATH=/app/data/aipilot.db \
  -e NODE_ENV=production \
  ai-pilot-auth
```

### Проверка, что БД сохранилась

```bash
# Остановить
docker stop -t 30 ai-pilot-auth

# Запустить заново (тот же volume)
docker start ai-pilot-auth

# Проверить health
curl -H "X-Deploy-Token: your-token" http://localhost:3001/api/health/db
```

---

## Что хранится в /app/data

| Файл | Назначение |
|------|-----------|
| `aipilot.db` | SQLite-БД (пользователи, сайты, чаты) |
| `aipilot.db.tmp` | Временный файл атомарной записи |
| `aipilot.json` | Legacy JSON (автомиграция при первом запуске) |
| `backups/` | Резервные копии (при ручном backup через API) |

---

## Backup

### Через API (требует admin JWT)

```bash
curl -X POST http://localhost:3001/api/backup \
  -H "Authorization: Bearer <admin-jwt>"
```

### Ручное копирование

```bash
docker exec ai-pilot-auth sh -c "cp /app/data/aipilot.db /app/data/backups/manual-$(date +%Y%m%d).db"
```
