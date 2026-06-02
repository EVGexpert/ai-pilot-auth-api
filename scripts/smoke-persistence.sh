#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Smoke Test: Persistence After Container Restart
#
# Доказывает, что пользователь, сайт и сообщения сохраняются
# после рестарта контейнера (docker stop → docker start).
#
# Использование:
#   bash scripts/smoke-persistence.sh
#
# Требования:
#   - Docker
#   - Image ai-pilot-auth уже собран (docker build -t ai-pilot-auth .)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VOLUME_NAME="ai-pilot-auth-smoke-$(date +%s)"
CONTAINER_NAME="ai-pilot-auth-smoke"
IMAGE_NAME="${IMAGE_NAME:-ai-pilot-auth}"
PORT="${PORT:-3099}"

JWT_SECRET="smoke-test-secret-32chars-minimum!!"
DEPLOY_HEALTH_TOKEN="smoke-deploy-token-00000"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${YELLOW}ℹ️${NC}  $1"; }

cleanup() {
  info "Cleaning up..."
  docker stop -t 5 "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
  docker volume rm "$VOLUME_NAME" 2>/dev/null || true
}

trap cleanup EXIT

echo ""
echo "═══════════════════════════════════════"
echo "  🔥 SMOKE TEST: PERSISTENCE"
echo "═══════════════════════════════════════"

# --------------------------------------------------
# Шаг 1: Создаём временный volume
# --------------------------------------------------
info "Step 1: Creating temporary volume..."
docker volume create "$VOLUME_NAME" >/dev/null
pass "Volume created: $VOLUME_NAME"

# --------------------------------------------------
# Шаг 2: Запускаем контейнер
# --------------------------------------------------
info "Step 2: Starting container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1:$PORT:3001" \
  -v "$VOLUME_NAME:/app/data" \
  -e NODE_ENV=production \
  -e PORT=3001 \
  -e DATABASE_PATH=/app/data/aipilot.db \
  -e JWT_SECRET="$JWT_SECRET" \
  -e DEPLOY_HEALTH_TOKEN="$DEPLOY_HEALTH_TOKEN" \
  "$IMAGE_NAME" >/dev/null

# Ждём старта
sleep 3
STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  pass "Container started"
else
  fail "Container not running (status=$STATUS)"
  exit 1
fi

# --------------------------------------------------
# Шаг 3: Проверяем health
# --------------------------------------------------
info "Step 3: Checking health..."
HEALTH=$(curl -sf http://localhost:$PORT/api/health 2>/dev/null || echo "")
if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='ok'" 2>/dev/null; then
  pass "Health endpoint OK"
else
  fail "Health endpoint failed: $HEALTH"
fi

# --------------------------------------------------
# Шаг 4: Регистрируем пользователя
# --------------------------------------------------
info "Step 4: Creating test user..."
TIMESTAMP=$(date +%s)
USER_EMAIL="smoke-${TIMESTAMP}@example.com"
USER_PASS="smoke-test-password-123"

REG=$(curl -sf -X POST http://localhost:$PORT/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASS\"}" 2>/dev/null || echo "")
if echo "$REG" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('user')" 2>/dev/null; then
  USER_ID=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])")
  pass "User created: $USER_EMAIL (id=$USER_ID)"
else
  fail "User creation failed: $(echo "$REG" | head -c 200)"
  exit 1
fi

# --------------------------------------------------
# Шаг 5: Логинимся
# --------------------------------------------------
info "Step 5: Logging in..."
LOGIN=$(curl -sf -X POST http://localhost:$PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASS\"}" 2>/dev/null || echo "")
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  pass "Login OK, token received (len=${#TOKEN})"
else
  fail "Login failed: $(echo "$LOGIN" | head -c 200)"
  exit 1
fi

# --------------------------------------------------
# Шаг 6: Прямая запись в БД (тестовый site)
# --------------------------------------------------
info "Step 6: Adding test site via DB..."
SITE_ID="smoke-site-${TIMESTAMP}"
SITE_URL="https://smoke-${TIMESTAMP}.example.com"

docker exec "$CONTAINER_NAME" node -e "
const initSqlJs = require('sql.js');
const fs = require('fs');
const buf = fs.readFileSync('/app/data/aipilot.db');
const db = new SQL.Database(buf);
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
db.run('INSERT INTO sites (id, user_id, url, name, api_token, verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ['$SITE_ID', '$USER_ID', '$SITE_URL', 'Smoke Test Site', 'smoke-token', 1, now, now]);
db.run('INSERT INTO chat_sessions (id, user_id, site_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ['smoke-session-${TIMESTAMP}', '$USER_ID', '$SITE_ID', 'Smoke Chat', now, now]);
db.run('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)',
  ['smoke-msg-${TIMESTAMP}', 'smoke-session-${TIMESTAMP}', 'user', 'Hello from smoke test', now]);
const data = db.export();
fs.writeFileSync('/app/data/aipilot.db', Buffer.from(data));
db.close();
console.log('OK');
" 2>/dev/null || echo "DB_ERROR"

# Проверяем через health endpoint
DB_CHECK=$(curl -sf -H "X-Deploy-Token: $DEPLOY_HEALTH_TOKEN" http://localhost:$PORT/api/health/db 2>/dev/null || echo "")
SITE_COUNT=$(echo "$DB_CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sites',0))" 2>/dev/null || echo 0)
if [ "$SITE_COUNT" -ge 1 ]; then
  pass "Site persisted in DB"
else
  fail "Site not found in DB: $DB_CHECK"
fi

# --------------------------------------------------
# Шаг 7: Graceful stop контейнера
# --------------------------------------------------
info "Step 7: Graceful stop..."
docker stop -t 30 "$CONTAINER_NAME" >/dev/null
sleep 1
STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "removed")
if [ "$STATUS" = "exited" ]; then
  pass "Container stopped gracefully"
else
  fail "Container not stopped (status=$STATUS)"
fi

# --------------------------------------------------
# Шаг 8: Запускаем новый контейнер с тем же volume
# --------------------------------------------------
info "Step 8: Restarting with same volume..."
docker rm "$CONTAINER_NAME" >/dev/null
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1:$PORT:3001" \
  -v "$VOLUME_NAME:/app/data" \
  -e NODE_ENV=production \
  -e PORT=3001 \
  -e DATABASE_PATH=/app/data/aipilot.db \
  -e JWT_SECRET="$JWT_SECRET" \
  -e DEPLOY_HEALTH_TOKEN="$DEPLOY_HEALTH_TOKEN" \
  "$IMAGE_NAME" >/dev/null

sleep 3
STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null)
if [ "$STATUS" = "running" ]; then
  pass "Container restarted with same volume"
else
  fail "Container restart failed (status=$STATUS)"
  exit 1
fi

# --------------------------------------------------
# Шаг 9: Проверяем health после рестарта
# --------------------------------------------------
info "Step 9: Checking health after restart..."
HEALTH2=$(curl -sf http://localhost:$PORT/api/health 2>/dev/null || echo "")
if echo "$HEALTH2" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('status')=='ok'" 2>/dev/null; then
  pass "Health endpoint OK after restart"
else
  fail "Health endpoint failed after restart: $HEALTH2"
fi

# --------------------------------------------------
# Шаг 10: Проверяем логин после рестарта
# --------------------------------------------------
info "Step 10: Checking login after restart..."
LOGIN2=$(curl -sf -X POST http://localhost:$PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASS\"}" 2>/dev/null || echo "")
TOKEN2=$(echo "$LOGIN2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
if [ -n "$TOKEN2" ]; then
  pass "Login works after restart"
else
  fail "Login failed after restart: $(echo "$LOGIN2" | head -c 200)"
fi

# --------------------------------------------------
# Шаг 11: Проверяем данные БД после рестарта
# --------------------------------------------------
info "Step 11: Checking DB data after restart..."
DB_CHECK2=$(curl -sf -H "X-Deploy-Token: $DEPLOY_HEALTH_TOKEN" http://localhost:$PORT/api/health/db 2>/dev/null || echo "")
CHECK_USERS=$(echo "$DB_CHECK2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('users',0))" 2>/dev/null || echo 0)
CHECK_SITES=$(echo "$DB_CHECK2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sites',0))" 2>/dev/null || echo 0)

if [ "$CHECK_USERS" -ge 1 ]; then
  pass "User persisted: $CHECK_USERS user(s)"
else
  fail "Users NOT persisted after restart!"
fi

if [ "$CHECK_SITES" -ge 1 ]; then
  pass "Site persisted: $CHECK_SITES site(s)"
else
  fail "Site NOT persisted after restart!"
fi

# --------------------------------------------------
# Шаг 12: Проверяем через CLI-скрипт
# --------------------------------------------------
info "Step 12: Checking via CLI script..."
CLI_CHECK=$(docker exec "$CONTAINER_NAME" node scripts/db-health.js 2>/dev/null || echo '{"status":"error"}')
CLI_STATUS=$(echo "$CLI_CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
CLI_USERS=$(echo "$CLI_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('users',0))" 2>/dev/null || echo 0)
if [ "$CLI_STATUS" = "ok" ] && [ "$CLI_USERS" -ge 1 ]; then
  pass "CLI script works: $CLI_USERS users"
else
  fail "CLI script failed: $CLI_CHECK"
fi

# ============================================================
# Финальный отчёт
# ============================================================
echo ""
echo "═══════════════════════════════════════"
echo "  📋 SMOKE TEST RESULTS"
echo "═══════════════════════════════════════"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "═══════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}❌ SMOKE TEST FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}✅ SMOKE TEST PASSED${NC}"
  exit 0
fi
