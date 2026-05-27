import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 10

/**
 * Хеширование пароля — bcryptjs (совместимость с существующими хешами в БД).
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS)
}

/**
 * Верификация пароля через bcryptjs.
 */
export async function verifyPassword(password, hashed) {
  return bcrypt.compare(password, hashed)
}
