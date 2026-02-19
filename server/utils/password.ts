import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

const SALT_LEN = 16
const KEY_LEN = 32
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString('base64url')
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${salt}:${key.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyB64] = stored.split(':')
  if (!salt || !keyB64) return false
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  const keyStored = Buffer.from(keyB64, 'base64url')
  return key.length === keyStored.length && timingSafeEqual(key, keyStored)
}
