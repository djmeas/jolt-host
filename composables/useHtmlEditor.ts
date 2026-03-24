/**
 * Composable for HTML processing and edit state tracking.
 * - Wraps HTML fragments into full documents
 * - Injects the editor bridge script
 * - Strips injected code for clean export
 * - Tracks per-element text edits
 */

import { getEditorBridgeHtml } from './useEditorBridge'

const BRIDGE_MARKER_START = '<!-- jolt-editor-bridge -->'
const BRIDGE_MARKER_END = '<!-- /jolt-editor-bridge -->'

/**
 * Wrap an HTML fragment in a full document if it isn't one already.
 */
function ensureFullDocument(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    return trimmed
  }
  return `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>${trimmed}</body>\n</html>`
}

/**
 * Strip Content-Security-Policy meta tags that could block the injected script.
 */
function stripCspMeta(html: string): string {
  return html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
}

/**
 * Prepare user HTML for the editor iframe by wrapping, stripping CSP, and injecting the bridge.
 */
export function prepareHtmlForEditor(raw: string): string {
  let html = ensureFullDocument(raw)
  if (!html) return ''
  html = stripCspMeta(html)

  const bridgeHtml = getEditorBridgeHtml()

  // Inject before </body> if present, otherwise before </html>, otherwise append
  const bodyClose = html.lastIndexOf('</body>')
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + '\n' + bridgeHtml + '\n' + html.slice(bodyClose)
  }
  const htmlClose = html.lastIndexOf('</html>')
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + '\n' + bridgeHtml + '\n' + html.slice(htmlClose)
  }
  return html + '\n' + bridgeHtml
}

/**
 * Strip the injected editor bridge from serialized HTML.
 */
export function cleanEditorHtml(html: string): string {
  const startIdx = html.indexOf(BRIDGE_MARKER_START)
  const endIdx = html.indexOf(BRIDGE_MARKER_END)
  if (startIdx === -1 || endIdx === -1) return html
  // Remove from marker start to marker end (inclusive)
  const before = html.slice(0, startIdx)
  const after = html.slice(endIdx + BRIDGE_MARKER_END.length)
  // Clean up blank lines left behind
  return (before + after).replace(/\n{3,}/g, '\n\n')
}

/**
 * Composable for tracking edits.
 */
export function useEditTracker() {
  const edits = reactive(new Map<string, { original: string; current: string }>())

  function trackEdit(path: string, original: string, newText: string) {
    const existing = edits.get(path)
    edits.set(path, {
      original: existing?.original ?? original,
      current: newText,
    })
  }

  function editCount() {
    return edits.size
  }

  function clearEdits() {
    edits.clear()
  }

  return { edits, trackEdit, editCount, clearEdits }
}
