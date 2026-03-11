import { createHash, randomBytes } from 'crypto'
import { randomUUID } from 'crypto'

const TOKEN_PREFIX = 'jolt_'
const TOKEN_BYTES = 32

export function generateApiToken(): { raw: string; hash: string } {
  const raw = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
  const hash = createHash('sha256').update(raw).digest('base64url')
  return { raw, hash }
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function createTokenWithNickname(nickname: string): { id: string; raw: string; hash: string } {
  const { raw, hash } = generateApiToken()
  const id = randomUUID()
  return { id, raw, hash }
}
