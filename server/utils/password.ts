const SALT_LEN = 16
const KEY_LEN = 32
const ITERATIONS = 100_000

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    keyMaterial,
    KEY_LEN * 8
  )
  return `${toBase64Url(salt.buffer)}:${toBase64Url(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, keyB64] = stored.split(':')
  if (!saltB64 || !keyB64) return false
  const salt = fromBase64Url(saltB64)
  const storedKey = fromBase64Url(keyB64)
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    keyMaterial,
    KEY_LEN * 8
  )
  const derived = new Uint8Array(bits)
  if (derived.length !== storedKey.length) return false
  // Constant-time comparison
  let diff = 0
  for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ storedKey[i]
  return diff === 0
}
