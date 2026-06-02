# Connect Code Security

## Rate Limiting

`POST /api/sites/connect-code` защищён per-IP rate limit:

- **Максимум:** 5 попыток в минуту
- **Хранение:** in-memory Map (сбрасывается при рестарте — не критично)
- **При превышении:** HTTP 429 + audit event

Дополнительно общий rate limit (20 req/min) на всё приложение.

## Валидация URL

Входящий URL проходит через `normalizeSiteUrl()`:

| Проверка | Описание |
|----------|----------|
| trim + lowercase | Приводим к каноническому виду |
| Trailing slash | Убираем `/` в конце |
| Протокол | Только http:// или https:// |
| Private IP (production) | localhost, 127.0.0.1, 10.x.x.x, 172.16-31.x.x, 192.168.x.x — запрещены |

## Error Codes

| error | HTTP | Причина |
|-------|------|---------|
| `code_required` | 400 | Не передан code или siteUrl |
| `invalid_url` | 400 | URL не прошёл валидацию |
| `too_many_attempts` | 429 | Превышен rate limit |
| `wp_plugin_not_found` | 404 | Плагин AI Pilot не обнаружен на сайте |
| `code_invalid` | 404/422 | Код недействителен или истёк |
| `site_unreachable` | 502 | Сайт не отвечает или вернул ошибку |

## Audit Events

Неудачные попытки логируются в `audit_events`:

| event_type | Когда |
|-----------|-------|
| `connect_code_rate_limited` | Превышен rate limit |
| `connect_code_failed` | Недействительный код или недоступный сайт |
| `connect_code_error` | Сетевая ошибка |
| `site_connected` | Успешное подключение |

**Чего нет в логах:**
- Сам verification code
- API token
- JWT secret
- Пароли

## Рекомендации

1. Установите строгий rate limit (уже сделано)
2. Не логируйте verification code (уже сделано)
3. Клиент должен показывать понятные ошибки на основе `error` поля
