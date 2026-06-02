# Persistence Smoke Test

## Назначение

Доказать, что пользователь, сайт и сообщения сохраняются после рестарта контейнера (`docker stop → docker start` с тем же volume).

## Как запустить

```bash
# 1. Собрать образ
docker build -t ai-pilot-auth .

# 2. Запустить smoke-test
bash scripts/smoke-persistence.sh
```

## Что проверяется

| Шаг | Проверка |
|-----|----------|
| 1 | Docker volume создаётся |
| 2 | Контейнер с production env запускается |
| 3 | Health endpoint (GET /api/health) отвечает |
| 4 | Регистрация пользователя через API |
| 5 | Логин с получением JWT |
| 6 | Прямая запись site/session/message в БД |
| 7 | Graceful stop (docker stop -t 30) |
| 8 | Рестарт с тем же volume |
| 9 | Health endpoint работает после рестарта |
| 10 | Логин работает после рестарта |
| 11 | DB healthcheck показывает users > 0 |
| 12 | CLI script (db-health.js) показывает те же данные |

## Критерии прохождения

- ✅ Login работает после рестарта (тот же email/password)
- ✅ Users > 0 после рестарта
- ✅ Sites > 0 после рестарта
- ❌ Любой FAIL → smoke-test падает с exit 1

## Ожидаемый вывод

```
═══════════════════════════════════════
  🔥 SMOKE TEST: PERSISTENCE
═══════════════════════════════════════
ℹ️  Step 1: Creating temporary volume...
✅ PASS: Volume created: ai-pilot-auth-smoke-...
ℹ️  Step 2: Starting container...
✅ PASS: Container started
...
═══════════════════════════════════════
  📋 SMOKE TEST RESULTS
═══════════════════════════════════════
  Passed: 12
  Failed: 0
═══════════════════════════════════════
✅ SMOKE TEST PASSED
```

## Очистка

Скрипт сам удаляет volume и контейнер при завершении (через `trap cleanup EXIT`).
