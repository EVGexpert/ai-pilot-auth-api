#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}✅ PASS${NC}: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${YELLOW}ℹ️${NC}  $1"; }

cleanup() {
  local pids
  pids=$(pgrep -f "node src/index.js" 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "═══════════════════════════════════════"
echo "  📋 REGRESSION: PERSISTENCE"
echo "═══════════════════════════════════════"

info "Test 1: Production без DATABASE_PATH..."
T1=$(cd "$REPO_DIR" && NODE_ENV=production node -e "import('./src/config.js')" 2>&1 || true)
if echo "$T1" | grep -q "DATABASE_PATH is required"; then
  pass "Production rejected without DATABASE_PATH"
else
  fail "Expected DATABASE_PATH error: $(echo "$T1" | head -1)"
fi

info "Test 2: Production без JWT_SECRET..."
T2=$(cd "$REPO_DIR" && NODE_ENV=production DATABASE_PATH=/app/data/test.db node -e "import('./src/config.js')" 2>&1 || true)
if echo "$T2" | grep -q "JWT_SECRET is required"; then
  pass "Production rejected without JWT_SECRET"
else
  fail "Expected JWT_SECRET error: $(echo "$T2" | head -1)"
fi

info "Test 3: Production с коротким JWT_SECRET..."
T3=$(cd "$REPO_DIR" && NODE_ENV=production DATABASE_PATH=/app/data/test.db JWT_SECRET=short node -e "import('./src/config.js')" 2>&1 || true)
if echo "$T3" | grep -q "must be at least 32"; then
  pass "Production rejected short JWT_SECRET"
else
  fail "Expected min length error: $(echo "$T3" | head -1)"
fi

info "Test 4: db-health.js без сервера (no DB)..."
mkdir -p /tmp/test-reg
T4=$(DATABASE_PATH=/tmp/test-reg/nope.db node "$REPO_DIR/scripts/db-health.js" 2>/dev/null)
S4=$(echo "$T4" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'],d['databaseExists'])" 2>/dev/null || echo "FAIL")
if [ "$S4" = "ok False" ]; then
  pass "db-health.js works without server (no DB)"
else
  fail "Got '$S4', expected 'ok False'"
fi

cd "$REPO_DIR"
info "Test 4b: db-health.js с существующей БД..."
mkdir -p /tmp/test-reg
cd "$REPO_DIR" && node --input-type=module <<'HEREDOC' >/dev/null 2>&1 || true
import initSqlJs from 'sql.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
const SQL = await initSqlJs({locateFile: f => 'node_modules/sql.js/dist/'+f});
const db = new SQL.Database();
db.run('CREATE TABLE users (id TEXT, email TEXT)');
db.run('INSERT INTO users VALUES ("1", "test@test.com")');
if (!existsSync('/tmp/test-reg')) mkdirSync('/tmp/test-reg', {recursive: true});
writeFileSync('/tmp/test-reg/real.db', Buffer.from(db.export()));
db.close();
HEREDOC

T4b=$(DATABASE_PATH=/tmp/test-reg/real.db node "$REPO_DIR/scripts/db-health.js" 2>/dev/null)
S4b=$(echo "$T4b" | python3 -c "
import sys,json; d=json.load(sys.stdin);
print(d['databaseExists'], d['users'], d['status'])
" 2>/dev/null || echo "FAIL")
if echo "$S4b" | grep -q "True 1 partial"; then
  pass "db-health.js reads DB (partial=expected for minimal schema)"
else
  fail "Got '$S4b', expected 'True 1 partial'"
fi

info "Test 5: /api/stats без auth возвращает 401..."
T5=$(cd "$REPO_DIR" && PORT=3095 NODE_ENV=development DATABASE_PATH=/tmp/test-reg/stats.db JWT_SECRET=test-test-test-test-32chars-minimum!! \
  timeout 10 bash -c '
    node src/index.js >/dev/null 2>&1 &
    PID=$!
    sleep 2
    CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3095/api/stats 2>/dev/null || echo "000")
    kill $PID 2>/dev/null || true
    echo "$CODE"
  ' 2>/dev/null || echo "000")
if [ "$T5" = "401" ]; then
  pass "/api/stats returns 401 without auth"
else
  fail "Got '$T5', expected '401'"
fi

info "Test 6: /api/health/db X-Deploy-Token..."
T6=$(cd "$REPO_DIR" && PORT=3096 NODE_ENV=development DATABASE_PATH=/tmp/test-reg/health.db JWT_SECRET=test-test-test-test-32chars-minimum!! DEPLOY_HEALTH_TOKEN=deploy-token-123 \
  timeout 12 bash -c '
    node src/index.js >/dev/null 2>&1 &
    PID=$!
    sleep 2
    R1=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Deploy-Token: deploy-token-123" http://localhost:3096/api/health/db 2>/dev/null || echo "000")
    R2=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Deploy-Token: wrong" http://localhost:3096/api/health/db 2>/dev/null || echo "000")
    R3=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3096/api/health/db 2>/dev/null || echo "000")
    kill $PID 2>/dev/null || true
    echo "$R1 $R2 $R3"
  ' 2>/dev/null || echo "TIMEOUT")
if echo "$T6" | grep -q "200 403 401"; then
  pass "/api/health/db codes: 200/403/401"
else
  fail "Got '$T6', expected '200 403 401'"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  📋 REGRESSION RESULTS"
echo "═══════════════════════════════════════"
echo "  Passed: $PASS / $TOTAL"
echo "  Failed: $FAIL / $TOTAL"
echo "═══════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}❌ REGRESSION FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}✅ REGRESSION PASSED${NC}"
  exit 0
fi
