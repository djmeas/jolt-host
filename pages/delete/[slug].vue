<script setup lang="ts">
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const route = useRoute()
const slug = route.params.slug as string
const token = route.query.token as string | undefined
const deleted = computed(() => route.query.deleted === '1')

onMounted(() => {
  if (!token && !deleted.value) navigateTo('/')
})

const deleting = ref(false)
const error = ref<string | null>(null)

const siteUrl = computed(() => {
  if (import.meta.client) return `${window.location.origin}/view/${slug}`
  const req = useRequestURL()
  return `${req.origin}/view/${slug}`
})

async function confirmDelete() {
  deleting.value = true
  error.value = null
  try {
    await $fetch(`/api/paste/${slug}/delete`, {
      method: 'POST',
      body: { owner_token: token },
    })
    await navigateTo(`/delete/${slug}?deleted=1`)
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    error.value = err.data?.message ?? err.message ?? 'Delete failed'
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <template v-if="deleted">
        <p class="status-icon">🗑️</p>
        <h1 class="title">Site deleted</h1>
        <p class="desc">The site has been permanently removed.</p>
        <NuxtLink to="/" class="home-btn">Upload a new site</NuxtLink>
      </template>

      <template v-else>
        <p class="warning-icon">⚠️</p>
        <h1 class="title">Delete this site?</h1>
        <p class="desc">
          This will permanently delete
          <a :href="siteUrl" target="_blank" rel="noopener" class="site-link">{{ siteUrl }}</a>
          and cannot be undone.
        </p>
        <p v-if="error" class="error">{{ error }}</p>
        <div class="actions">
          <button
            type="button"
            class="delete-btn"
            :disabled="deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Deleting…' : 'Yes, delete it' }}
          </button>
          <NuxtLink to="/" class="cancel-btn">Cancel</NuxtLink>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.box {
  width: 100%;
  max-width: 400px;
  padding: 2rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  text-align: center;
}
.warning-icon,
.status-icon {
  font-size: 2rem;
  margin: 0 0 0.75rem;
}
.title {
  margin: 0 0 0.75rem;
  font-size: 1.3rem;
  font-weight: 600;
  color: #f4f4f5;
}
.desc {
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  line-height: 1.6;
}
.site-link {
  color: #a78bfa;
  text-decoration: none;
  word-break: break-all;
}
.site-link:hover {
  text-decoration: underline;
}
.error {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: #f87171;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.delete-btn {
  width: 100%;
  padding: 0.6rem 1rem;
  font-size: 0.95rem;
  font-weight: 500;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  color: #fca5a5;
  cursor: pointer;
}
.delete-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.6);
}
.delete-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.cancel-btn {
  display: block;
  padding: 0.6rem 1rem;
  font-size: 0.95rem;
  color: #71717a;
  text-decoration: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
}
.cancel-btn:hover {
  color: #a1a1aa;
  border-color: rgba(255, 255, 255, 0.2);
}
.home-btn {
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.6rem 1.25rem;
  font-size: 0.9rem;
  font-weight: 500;
  background: rgba(167, 139, 250, 0.15);
  border: 1px solid rgba(167, 139, 250, 0.35);
  border-radius: 8px;
  color: #c4b5fd;
  text-decoration: none;
}
.home-btn:hover {
  background: rgba(167, 139, 250, 0.25);
}
</style>
