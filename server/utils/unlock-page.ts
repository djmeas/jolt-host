/**
 * Jolt-owned password forms for hosted sites. These pages are rendered by Jolt,
 * not by the uploaded site, and are never exposed to the site's own scripts.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export type PasswordFormOptions = {
  action: string
  heading: string
  lead: string
  submitLabel?: string
  error?: string
  note?: string
}

export function renderPasswordForm(options: PasswordFormOptions): string {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''
  const note = options.note ? `<p class="note">${escapeHtml(options.note)}</p>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(options.heading)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0f0f12; color: #e4e4e7; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .box { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 2rem; width: 100%; max-width: 360px; }
    h1 { margin: 0 0 1rem; font-size: 1.25rem; font-weight: 600; }
    p { margin: 0 0 1rem; font-size: 0.9rem; color: #a1a1aa; }
    input { width: 100%; padding: 0.75rem 1rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: rgba(255,255,255,0.06); color: #e4e4e7; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: none; border-color: #a78bfa; }
    button { width: 100%; padding: 0.75rem; background: rgba(167,139,250,0.3); border: 1px solid rgba(167,139,250,0.5); border-radius: 8px; color: #c4b5fd; font-size: 1rem; cursor: pointer; font-weight: 500; }
    button:hover { background: rgba(167,139,250,0.4); }
    .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; }
    .note { color: #71717a; font-size: 0.8rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(options.heading)}</h1>
    <p>${escapeHtml(options.lead)}</p>
    ${error}
    <form method="post" action="${escapeHtml(options.action)}">
      <input type="password" name="password" placeholder="Password" required autofocus autocomplete="current-password">
      <button type="submit">${escapeHtml(options.submitLabel ?? 'Unlock')}</button>
    </form>
    ${note}
  </div>
</body>
</html>`
}

export function renderUnlockPage(error?: string): string {
  return renderPasswordForm({
    action: '/_jolt/unlock',
    heading: 'This site is protected',
    lead: 'Enter the password to view it.',
    error,
  })
}

export function renderDataLoginPage(error?: string): string {
  return renderPasswordForm({
    action: '/_jolt/data/login',
    heading: 'Sign in to edit site data',
    lead: 'Enter the site password to read and edit this site\u2019s shared data.',
    submitLabel: 'Continue',
    error,
    note: 'Everyone who knows this password can change the shared data.',
  })
}
