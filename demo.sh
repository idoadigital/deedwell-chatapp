#!/usr/bin/env bash
# Deedwell demo stack: API (:3001) + Site Router (:8788) + workspace app (:4173).
# Put OPENAI_API_KEY=sk-... in /root/deedwell/.env to switch the AI team from
# the rule-based mock to real language understanding (restart after editing .env;
# TS source changes hot-reload via tsx watch — no restart needed).
set -euo pipefail
cd /root/deedwell
[ -f .env ] && set -a && source .env && set +a

export DATABASE_URL=${DATABASE_URL:-postgres://deedwell:deedwell@localhost:55432/deedwell_demo}
export APP_DB_PASSWORD=${APP_DB_PASSWORD:-test_app_password}
export DATABASE_APP_URL=${DATABASE_APP_URL:-postgres://deedwell_app:${APP_DB_PASSWORD}@localhost:55432/deedwell_demo}
export DATA_DIR=${DATA_DIR:-/root/deedwell/.data-demo}
export GRANT_SOURCE=${GRANT_SOURCE:-grants_gov}
export RESEARCH_FETCH=${RESEARCH_FETCH:-browser}
export LOG_LEVEL=${LOG_LEVEL:-warn}
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "paste-your-key-here" ]; then
  export MODEL_PROVIDER=${MODEL_PROVIDER:-openai}
  echo "Model provider: openai (${OPENAI_MODEL:-gpt-4o-mini})"
else
  export MODEL_PROVIDER=${MODEL_PROVIDER:-mock}
  echo "Model provider: mock (add OPENAI_API_KEY to .env for real language understanding)"
fi

# Streaming STT engine (memory-capped small model; see infrastructure/stt).
docker start deedwell-stt >/dev/null 2>&1 || true

# Stop anything already on our ports.
ss -tlnp 2>/dev/null | grep -E ':(3001|4173|8788)' | grep -oP 'pid=\K[0-9]+' | sort -u | xargs -r kill || true
sleep 1

CORS_ORIGINS="http://178.104.188.229:4173,http://localhost:4173,http://localhost:5173,tauri://localhost" \
  PORT=3001 nohup node_modules/.bin/tsx watch --clear-screen=false apps/api/src/main.ts > .demo-api.log 2>&1 &
SITE_ROUTER_PORT=8788 nohup node_modules/.bin/tsx watch --clear-screen=false apps/site-router/src/main.ts > .demo-router.log 2>&1 &
(cd apps/desktop && nohup node_modules/.bin/vite preview --host 0.0.0.0 --port 4173 > ../../.demo-app.log 2>&1 &)
sleep 4
echo "API:    $(curl -s localhost:3001/healthz || echo DOWN)"
echo "Router: $(curl -s localhost:8788/healthz || echo DOWN)"
echo "App:    HTTP $(curl -s -o /dev/null -w '%{http_code}' localhost:4173)"
echo "Workspace: http://178.104.188.229:4173"
