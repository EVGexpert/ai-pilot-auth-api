FROM node:24-alpine
WORKDIR /app

# dumb-init for proper PID 1 signal handling + curl for healthcheck
RUN apk add --no-cache dumb-init curl

# Production defaults (можно переопределить при docker run)
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/aipilot.db
ENV NODE_OPTIONS="--max-old-space-size=384 --expose-gc"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Директория для SQLite (без VOLUME — bind mount из deploy.yml)
RUN mkdir -p /app/data

EXPOSE 3001

# ─── СТАРТОВЫЙ СКРИПТ ───
# 1. Удаляет VOLUME declaration (мешает bind mount)
# 2. Проверяет/чинит права на /app/data
# 3. Удаляет WAL/SHM журналы
# 4. Если aipilot.db readonly — удаляет его (создастся свежий)
RUN printf '#!/bin/sh\n\nDATA=/app/data\nDB="$DATA/aipilot.db"\n\necho "init: checking $DB..."\nls -la "$DATA/" 2>&1\n\n# Права на всё\nchmod -R 777 "$DATA" 2>/dev/null\n\n# Удалить WAL/SHM/journal\nrm -f "$DATA"/*.db-wal "$DATA"/*.db-shm "$DATA"/*.db-journal 2>/dev/null\n\n# Проверка: можно писать в БД?\nif [ -f "$DB" ]; then\n  if ! touch "$DB" 2>/dev/null; then\n    echo "init: WARNING $DB not writable, removing..."\n    rm -f "$DB"\n  fi\nfi\n\necho "init: starting node..."\nexec node --experimental-sqlite src/index.js\n' > /app/entry.sh && chmod +x /app/entry.sh

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/entry.sh"]
