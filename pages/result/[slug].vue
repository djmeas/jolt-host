<script setup lang="ts">
const route = useRoute()
const slug = computed(() => route.params.slug as string)

const url = computed(() => {
  const s = slug.value
  if (!s) return ''
  if (import.meta.client) return `${window.location.origin}/view/${s}`
  const req = useRequestURL()
  return `${req.origin}/view/${s}`
})
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
      <NuxtLink to="/" class="back-link">← Upload another site</NuxtLink>
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
  background: rgba(255, 255, 255, 0.04);
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
</style>
