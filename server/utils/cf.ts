import type { H3Event } from 'h3'

interface CloudflareEnv {
  DB: D1Database
  BUCKET: R2Bucket
  /** Set in Cloudflare Pages/Workers env or secrets (e.g. wrangler pages secret put) */
  JOLT_ADMIN_PASSWORD?: string
}

export function useCloudflare(event: H3Event): CloudflareEnv {
  const env = (event.context.cloudflare?.env ?? event.context.env ?? {}) as CloudflareEnv
  return env
}

export function useDB(event: H3Event): D1Database {
  return useCloudflare(event).DB
}

export function useR2(event: H3Event): R2Bucket {
  return useCloudflare(event).BUCKET
}
