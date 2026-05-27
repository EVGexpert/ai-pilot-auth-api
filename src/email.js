import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter = null

function getTransporter() {
  if (transporter) return transporter

  if (config.SMTP_HOST && config.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
      }
    })
  }

  return transporter
}

export async function sendVerificationEmail(email, code) {
  const transport = getTransporter()

  if (!transport) {
    console.log(`[DEV] Verification code for ${email}: ${code}`)
    // В dev-режиме просто логируем код
    return
  }

  await transport.sendMail({
    from: `"AI Pilot" <${config.SMTP_USER}>`,
    to: email,
    subject: 'Подтверждение email — AI Pilot',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>🎯 AI Pilot</h2>
        <p>Ваш код подтверждения:</p>
        <div style="font-size:32px;letter-spacing:8px;text-align:center;padding:20px;background:#f5f5f5;border-radius:8px;margin:20px 0">
          <strong>${code}</strong>
        </div>
        <p style="color:#666">Код действителен 24 часа.</p>
      </div>
    `
  })
}

export async function sendWelcomeEmail(email, name) {
  const transport = getTransporter()
  if (!transport) return

  await transport.sendMail({
    from: `"AI Pilot" <${config.SMTP_USER}>`,
    to: email,
    subject: 'Добро пожаловать в AI Pilot!',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>🎯 Добро пожаловать${name ? ', ' + name : ''}!</h2>
        <p>Вы успешно зарегистрировались в AI Pilot.</p>
        <p>Теперь вы можете управлять своими WordPress-сайтами через чат.</p>
        <p><a href="${config.APP_URL}/chat" style="display:inline-block;padding:12px 24px;background:#667eea;color:white;border-radius:6px;text-decoration:none">Перейти в чат</a></p>
      </div>
    `
  })
}
