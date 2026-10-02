/**
 * Shared creation-result storage for the upload form, the AI Builder preview,
 * and the `/result/[slug]` page.
 *
 * Results are kept in `sessionStorage` only: a created site's owner token and
 * unlock URL must survive the navigation to `/result/<slug>` without being
 * persisted in `localStorage` or the URL.
 */

/** The creation result returned by `/api/upload`, `/api/paste`, `/api/markdown`, and `/api/ai/preview`. */
export interface UploadResult {
  slug: string
  url: string
  entry_point?: string
  owner_token?: string
  expires_at?: string
  title?: string
  data_enabled?: string
  url_with_unlock?: string
}

/** A stored result plus the optional site title the form collected. */
export interface StoredResult extends UploadResult {
  title?: string
}

/** Most recent creation result, shown by the upload form's own result flow. */
const RESULT_STORAGE_KEY = 'jolthost-last-upload'
/** Per-slug result, read by `/result/[slug]`. */
const RESULT_BY_SLUG_PREFIX = 'jolthost-result-'

export function useResultStorage() {
  /**
   * Saves a creation result under both sessionStorage keys so `/result/<slug>`
   * can render it after navigation. The stored title defaults to the result's
   * own title when the form did not supply one.
   */
  function saveResult(result: UploadResult, options: { title?: string } = {}): void {
    if (!import.meta.client) return
    try {
      const stored: StoredResult = {
        ...result,
        title: options.title?.trim() || result.title?.trim() || undefined,
      }
      sessionStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(stored))
      sessionStorage.setItem(`${RESULT_BY_SLUG_PREFIX}${result.slug}`, JSON.stringify(stored))
    } catch {}
  }

  /** Reads the stored result for one slug, or null when none/invalid was stored. */
  function readResult(slug: string): StoredResult | null {
    if (!import.meta.client || !slug) return null
    try {
      const raw = sessionStorage.getItem(`${RESULT_BY_SLUG_PREFIX}${slug}`)
      return raw ? (JSON.parse(raw) as StoredResult) : null
    } catch {
      return null
    }
  }

  return { saveResult, readResult }
}
