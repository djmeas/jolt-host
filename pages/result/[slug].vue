<script setup lang="ts">
import type { StoredResult } from '~/composables/useResultStorage'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()
const slug = computed(() => route.params.slug as string)

const storedResult = ref<StoredResult | null>(null)
const { addSite } = useMySites()
const { siteUrlFor } = useSiteUrl()
const { readResult } = useResultStorage()

onMounted(() => {
  const stored = readResult(slug.value)
  if (!stored) return
  storedResult.value = stored
  const baseUrl = stored.url_with_unlock || stored.url || siteUrlFor(slug.value)
  addSite({
    siteUrl: baseUrl,
    title: stored.title,
    createdAt: new Date().toISOString(),
    expiresAt: stored.expires_at || null,
  })
})

const url = computed(() => {
  const s = slug.value
  if (!s) return ''
  const base = storedResult.value?.url_with_unlock || storedResult.value?.url || siteUrlFor(s)
  const title = storedResult.value?.title
  if (title) {
    try {
      const u = new URL(base)
      u.searchParams.set('title', title)
      return u.toString()
    } catch {}
  }
  return base
})

const deleteUrl = computed(() => {
  const token = storedResult.value?.owner_token
  if (!token) return null
  return `/delete/${slug.value}?token=${encodeURIComponent(token)}`
})

const updateUrl = computed(() => `/update/${slug.value}`)

const copied = ref(false)

async function copyUrl() {
  if (!url.value) return
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch (_) {}
}
</script>

<template>
  <div class="page">
    <div class="box">
      <p class="result-success">Upload complete</p>
      <p class="result-label">Your site is live</p>
      <a :href="url" target="_blank" rel="noopener" class="result-link">
        {{ url }}
      </a>
      <div>
        <button type="button" class="copy" @click="copyUrl">
          {{ copied ? 'Copied!' : 'Copy URL' }}
        </button>
      </div>
      <div>
        <NuxtLink :to="updateUrl" class="update-link">Replace files</NuxtLink>
      </div>
      <div>
        <NuxtLink to="/" class="back-link">← Upload another site</NuxtLink>
      </div>
      <div v-if="deleteUrl" class="delete-wrap">
        <NuxtLink :to="deleteUrl" class="delete-link">Delete this site</NuxtLink>
        <span class="delete-hint">Only visible to you, once</span>
        <div class="token-wrap">
          <span class="token-label">Owner Token</span>
          <code class="token-value">{{ storedResult?.owner_token }}</code>
          <span class="token-hint">This is the only way we can identify your upload if you contact us to request deletion.</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.box {
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  padding: 2rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  text-align: center;
}
.result-success {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: #22c55e;
  font-weight: 500;
}
.result-label {
  margin: 1rem 0 0.5rem;
  font-size: 0.8rem;
  color: #a1a1aa;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: center;
}
.result-link {
  display: block;
  font-size: 0.95rem;
  color: #a78bfa;
  word-break: break-all;
  text-decoration: none;
  margin-bottom: 0.5rem;
  text-align: center;
}
.result-link:hover {
  text-decoration: underline;
}
.copy {
  padding: 0.4rem 0.75rem;
  font-size: 0.8rem;
  background: rgba(167, 139, 250, 0.2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
  margin-bottom: 0.5rem;
}
.copy:hover {
  background: rgba(167, 139, 250, 0.3);
}
.back-link {
  display: inline-block;
  margin-top: 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
.update-link {
  display: inline-block;
  margin-top: 0.75rem;
  font-size: 0.9rem;
  color: #c4b5fd;
  text-decoration: none;
}
.update-link:hover {
  text-decoration: underline;
}
.delete-wrap {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
}
.delete-link {
  font-size: 0.85rem;
  color: #71717a;
  text-decoration: none;
}
.delete-link:hover {
  color: #f87171;
}
.delete-hint {
  font-size: 0.75rem;
  color: #3f3f46;
}
.token-wrap {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
}
.token-label {
  font-size: 0.7rem;
  color: #52525b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.token-value {
  font-size: 0.75rem;
  color: #71717a;
  word-break: break-all;
  background: rgba(255, 255, 255, 0.04);
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
}
.token-hint {
  font-size: 0.7rem;
  color: #3f3f46;
  line-height: 1.4;
}
</style>
