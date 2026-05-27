export const config = {
  PORT: parseInt(process.env.PORT || '3001'),
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  DATABASE_PATH: process.env.DATABASE_PATH || './data/aipilot.db',
  APP_URL: process.env.APP_URL || 'https://pilotsite.ru',
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587'),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  GATEWAY_TOKEN: process.env.GATEWAY_TOKEN,
  GATEWAY_WS: process.env.GATEWAY_WS || 'ws://localhost:18789'
}
