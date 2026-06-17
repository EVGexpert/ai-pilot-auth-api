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

# Директория для SQLite — должна быть подключена как volume
RUN mkdir -p /app/data

EXPOSE 3001

# ⚠️ ВАЖНО: SQLite-БД хранится по DATABASE_PATH
# Для сохранения данных между рестартами обязательно подключите volume:
#   docker run -v /host/path:/app/data ...
VOLUME ["/app/data"]

# Обеспечиваем права на запись в volume БД
RUN mkdir -p /app/data

# ─── СТАРТОВЫЙ СКРИПТ ───
# Гарантирует права на БД, удаляет WAL/SHM остатки, чистит битые файлы
RUN printf '#!/bin/sh\nset -e\nfind /app/data -type d -exec chmod 777 {} + 2>/dev/null\nfind /app/data -type f -exec chmod 666 {} + 2>/dev/null\nrm -f /app/data/*.db-wal /app/data/*.db-shm /app/data/*.db-journal 2>/dev/null\necho "init: permissions set, stale files cleaned"\nexec node --experimental-sqlite src/index.js\n' > /app/entry.sh && chmod +x /app/entry.sh

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/entry.sh"]
