# User Persistence Workflow Audit

> Дата: 2026-06-02
> После изменений: production guards, graceful stop, atomic save, refresh-token flow

---

## 1. Что происходит при регистрации

```
Client → POST /api/auth/register {email, password}
         ↓
        1. Хэш пароля (bcryptjs)
        2. INSERT в users (SQLite)
        3. Создание verification code (email)
        4. generateToken() → access JWT (7d)
        5. createRefreshToken() → refresh token (30d, SHA256 в БД)
        6. reply.send({token, refreshToken, user})
        7. Попытка отправки email (неблокирующая)
```

**Критические точки:**
- Если SQLite упал между INSERT и generateToken — пользователь потерян
- **Решение:** dirty flag + atomic write → save в течение 1 секунды

---

## 2. Что происходит при входе

```
Client → POST /api/auth/login {email, password}
         ↓
        1. SELECT из users
        2. verifyPassword()
        3. generateToken() → access JWT
        4. createRefreshToken()
        5. reply.send({token, refreshToken, user, sites})
```

**Безопасность:**
- Пароль не возвращается (только хэш, и тот не в ответе)
- `user` содержит только id, email, name, role, emailVerified
- `sites` — только публичные поля (нет api_token)

---

## 3. Refresh-token flow

```
Client → POST /api/auth/refresh {refreshToken}
         ↓
        1. SHA256(refreshToken) → поиск по token_hash
        2. Проверка: не истёк, не revoked
        3. generateToken() → новый access JWT
        4. revokeRefreshToken(old) → revoked_at = now
        5. createRefreshToken() → новый refresh (rotation)
        6. reply.send({token, refreshToken})
```

**Безопасность:**
- Refresh token хранится только как SHA256 хэш
- При каждом refresh — старый отзывается, новый выдаётся
- Stolen token не может быть использован повторно (уже revoked)
- Logout: revokeRefreshToken() → устанавливает revoked_at

---

## 4. Как переживается рестарт

### docker stop (graceful)

```
docker stop -t 30
         ↓
SIGTERM → process.on('SIGTERM')
         ↓
close():
  1. saveTimer cleared
  2. if (dirty) → save() → writeFileSync(.tmp) → renameSync(.db)
  3. db.close()
  4. console.log('[DB] Closed: path (size bytes)')
```

### docker start (тот же volume)

```
docker start
         ↓
connection.js:
  1. existsSync(DB_PATH) → true
  2. readFileSync(DB_PATH) → Buffer
  3. new SQL.Database(buffer)
  4. SQL валидирует целостность
```

### После рестарта:

| Действие | Работает? | Почему |
|----------|-----------|--------|
| Логин тем же паролем | ✅ | password_hash в БД |
| Старый JWT (access) | ✅ | JWT_SECRET стабильный |
| Старый refreshToken | ✅ | до истечения 30 дней |
| Список сайтов | ✅ | sites в БД |
| История чата | ✅ | messages в БД |

---

## 5. Как переживается деплой

### deploy.yml (новый, после фиксов)

```
1. docker stop -t 30 id=ai-pilot-auth
   → SIGTERM → save() → close()
2. cp "$DB_FILE" "$BACKUP_DIR/backup-$(date).db"
3. docker rm ai-pilot-auth
4. git clone / docker build
5. docker run -v "$DATA_DIR:/app/data" -e DATABASE_PATH=/app/data/aipilot.db
   → volume тот же → БД на месте
6. curl /api/health/db → проверка
   → если users=0 → rollback из backup
```

### Критические проверки после деплоя:

```bash
# 1. DB health (не требует JWT)
curl -H "X-Deploy-Token: $DEPLOY_HEALTH_TOKEN" /api/health/db

# 2. Логин
curl -X POST /api/auth/login -d '{"email":"test@test.com","password":"..."}'

# 3. Refresh
curl -X POST /api/auth/refresh -d '{"refreshToken":"..."}'
```

---

## 6. Диаграмма состояний БД

```
                     ┌──────────────┐
                     │  DB не существует │
                     └──────┬───────┘
                            │ первый запуск
                            ↓
                     ┌──────────────┐
                     │  createSchema  │ ← CREATE TABLE IF NOT EXISTS
                     │  migrations    │ ← schema_version
                     └──────┬───────┘
                            │
                     ┌──────────────┐
                     │  dirty=false  │ ← save() после миграций
                     └──────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ↓             ↓             ↓
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  run()   │  │ SIGTERM │  │ 10s tick  │
        │ (INSERT) │  │  close  │  │  interval  │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             ↓             ↓             │
        ┌──────────┐  ┌──────────┐       │
        │dirty=true│  │ save()   │←──────┘
        └────┬─────┘  │ close()  │
             │        └──────────┘
             │ 1s delay
             ↓
        ┌──────────┐
        │ save()   │
        │ .tmp→.db │
        │dirty=false│
        └──────────┘
```

---

## 7. Что если что-то пошло не так

| Сценарий | Что происходит | Восстановление |
|----------|---------------|----------------|
| `docker kill -9` | SIGKILL без SIGTERM → save() не вызван | dirty data lost. При старте: последний .db файл (не .tmp) |
| Краш в середине save | .tmp файл не переименован | .db не повреждён (старая версия цела) |
| Повреждение .db файла | SQLite при старте падает | Rollback из backup (deploy) или ручное копирование |
| Volume не подключён | DB_PATH не существует → создаётся новая пустая БД | Deploy healthcheck sees users=0 → rollback |
| JWT_SECRET изменился | Все access token'ы невалидны | Refresh token работает (если refreshToken сохранён) |

---

## 8. Рекомендации по мониторингу

```bash
# Каждые 5 минут (cron)
curl -s -H "X-Deploy-Token: $TOKEN" http://localhost:3001/api/health/db

# Проверка размера БД
ls -lh /app/data/aipilot.db

# Проверка целостности (требует sqlite3 CLI)
# sqlite3 /app/data/aipilot.db "PRAGMA integrity_check;"

# Количество активных refresh токенов
# docker exec ai-pilot-auth node -e "
#   const { queryOne } = require('./src/db/connection.js');
#   const c = queryOne('SELECT COUNT(*) as c FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > datetime(\"now\")');
#   console.log('Active sessions:', c?.c || 0);
# "
```
