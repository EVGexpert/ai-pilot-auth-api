# Auth Refresh Token Flow

## Зачем

Без refresh-token при каждом деплое (или через 7 дней) все пользователи
должны заново логиниться. Refresh-token flow позволяет:

- Access token — короткий (15 минут по умолчанию)
- Refresh token — долгий (30 дней), хранится на клиенте
- Token rotation — каждый refresh отзывает старый и выдаёт новый
- Logout — отзывает только конкретный refresh token
- Logout-all — отзывает все refresh tokens пользователя

## Endpoints

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/api/auth/register` | Регистрация (возвращает token + refreshToken) |
| POST | `/api/auth/login` | Вход (возвращает token + refreshToken) |
| POST | `/api/auth/refresh` | Обновить access token по refreshToken |
| POST | `/api/auth/logout` | Выход (отозвать refreshToken) |
| POST | `/api/auth/logout-all` | Выход со всех устройств (требует JWT) |

## Login response

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "abc123...",
  "user": { "id": "...", "email": "...", "role": "client" },
  "sites": [...]
}
```

## Refresh flow

```javascript
// Клиент хранит refreshToken в http-only cookie или localStorage
async function refreshToken() {
  const resp = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: storedRefreshToken })
  })
  if (resp.ok) {
    const data = await resp.json()
    // Старый refreshToken недействителен, используем новый
    storedRefreshToken = data.refreshToken
    return data.token  // новый access token
  } else {
    // Refresh token истёк или отозван → перенаправить на логин
    redirectToLogin()
  }
}
```

## Безопасность

- Refresh token хранится в БД **только как SHA256-хэш**
- Сырой токен выдаётся клиенту один раз (при login/register/refresh)
- Token rotation: каждый refresh отзывает старый и выдаёт новый
- Refresh token не может быть использован для доступа к API (только для `/auth/refresh`)
- Рекомендуется хранить refreshToken на клиенте в httpOnly cookie

## Очистка

```bash
# Очистить истёкшие токены старше 90 дней вызывается вручную или по cron:
curl -X POST /api/auth/clean-expired
# или через node:
node -e "import('./src/db.js').then(m => m.cleanExpiredTokens())"
```

## Обратная совместимость

Старый клиент (который не знает о refreshToken) продолжает работать:
- `token` всё ещё в ответе
- `token` живёт 7 дней по умолчанию
- Новые поля (`refreshToken`) просто игнорируются старым клиентом
