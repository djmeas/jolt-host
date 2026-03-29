/**
 * Cloudflare Turnstile composable for the web upload forms.
 * Loads the Turnstile script and manages the widget lifecycle.
 *
 * When NUXT_PUBLIC_TURNSTILE_SITE_KEY is not set, the widget is disabled
 * and `isEnabled` is false — forms submit without a captcha token.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileOptions) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

interface TurnstileOptions {
  sitekey: string
  callback: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: () => void
  theme?: 'light' | 'dark' | 'auto'
}

export function useTurnstile() {
  const config = useRuntimeConfig()
  const siteKey = config.public.turnstileSiteKey as string
  const isEnabled = computed(() => Boolean(siteKey))

  const token = ref<string | null>(null)
  let widgetId: string | null = null

  if (import.meta.client && siteKey) {
    useHead({
      script: [
        {
          key: 'cf-turnstile-script',
          src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
          async: true,
          defer: true,
        },
      ],
    })
  }

  function renderWidget(el: HTMLElement) {
    if (!import.meta.client || !siteKey) return

    const attempt = () => {
      if (window.turnstile) {
        widgetId = window.turnstile.render(el, {
          sitekey: siteKey,
          theme: 'dark',
          callback: (t: string) => {
            token.value = t
          },
          'expired-callback': () => {
            token.value = null
          },
          'error-callback': () => {
            token.value = null
          },
        })
      } else {
        setTimeout(attempt, 150)
      }
    }
    attempt()
  }

  function reset() {
    token.value = null
    if (import.meta.client && widgetId !== null) {
      window.turnstile?.reset(widgetId)
    }
  }

  function cleanup() {
    if (import.meta.client && widgetId !== null) {
      window.turnstile?.remove(widgetId)
      widgetId = null
    }
    token.value = null
  }

  return { token, siteKey, isEnabled, renderWidget, reset, cleanup }
}
