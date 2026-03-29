/**
 * Cloudflare Turnstile server-side token verification.
 * When NUXT_TURNSTILE_SECRET_KEY is not set, verification is skipped
 * so development and testing work without a real Turnstile key.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstileToken(token: string | undefined, ip?: string): Promise<boolean> {
  const config = useRuntimeConfig()
  const secretKey = config.turnstileSecretKey as string | undefined

  if (!secretKey) {
    return true
  }

  if (!token) return false

  const params = new URLSearchParams({ secret: secretKey, response: token })
  if (ip) params.set('remoteip', ip)

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success: boolean }
    return data.success === true
  } catch {
    return false
  }
}
