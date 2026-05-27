import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export function generateToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || 'client'
    },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  )
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET)
  } catch {
    return null
  }
}

export async function authMiddleware(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing token' })
  }

  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }

  request.user = payload
}
