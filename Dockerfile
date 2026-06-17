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

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "chmod 777 /app/data /app/data/*.db* 2>/dev/null; exec node --experimental-sqlite src/index.js"]
