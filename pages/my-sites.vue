<script setup lang="ts">
useSeoMeta({ title: 'My Sites — Jolt Host' })

const { sites, load, clearSites } = useMySites()
const showConfirm = ref(false)

onMounted(() => {
  load()
})

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function confirmClear() {
  clearSites()
  showConfirm.value = false
}
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="title">My Sites</h1>

      <div class="banner">
        <svg class="banner-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
        </svg>
        <p class="banner-text">
          This page displays your recently published sites. This data is stored locally in your
          browser's localStorage for your personal use only, and will be lost if you clear your
          browser data.
        </p>
      </div>

      <div v-if="sites.length === 0" class="empty">
        <p class="empty-title">No sites yet</p>
        <p class="empty-sub">Upload a site to see it here.</p>
        <NuxtLink to="/" class="empty-cta">Upload a site →</NuxtLink>
      </div>

      <ul v-else class="site-list">
        <li v-for="site in sites" :key="site.siteUrl" class="site-card">
          <p v-if="site.title" class="site-title">{{ site.title }}</p>
          <a :href="site.siteUrl" target="_blank" rel="noopener" class="site-url">
            {{ site.siteUrl }}
          </a>
          <div class="site-meta">
            <span class="meta-item">
              <span class="meta-label">Published</span>
              <span class="meta-value">{{ formatDate(site.createdAt) }}</span>
            </span>
            <span class="meta-sep">·</span>
            <span class="meta-item">
              <span class="meta-label">Expires</span>
              <span class="meta-value">{{ formatDate(site.expiresAt) }}</span>
            </span>
          </div>
        </li>
      </ul>

      <div v-if="sites.length > 0" class="danger-zone">
        <button type="button" class="clear-btn" @click="showConfirm = true">
          Clear My Sites data
        </button>
      </div>
    </div>

    <!-- Confirmation modal -->
    <Teleport to="body">
      <div v-if="showConfirm" class="modal-backdrop" @click.self="showConfirm = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <p id="modal-title" class="modal-title">Clear My Sites data?</p>
          <p class="modal-body">
            This will permanently remove all saved site history from your browser's localStorage.
            This action cannot be undone.
          </p>
          <div class="modal-actions">
            <button type="button" class="modal-cancel" @click="showConfirm = false">Cancel</button>
            <button type="button" class="modal-confirm" @click="confirmClear">Clear data</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.container {
  width: 100%;
  max-width: 640px;
}
.title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #e4e4e7;
  margin: 0 0 1.25rem;
}
.banner {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  background: rgba(167, 139, 250, 0.08);
  border: 1px solid rgba(167, 139, 250, 0.2);
  border-radius: 10px;
  padding: 0.875rem 1rem;
  margin-bottom: 1.5rem;
}
.banner-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: #a78bfa;
  margin-top: 2px;
}
.banner-text {
  margin: 0;
  font-size: 0.875rem;
  color: #a1a1aa;
  line-height: 1.5;
}
.empty {
  text-align: center;
  padding: 3rem 1rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
}
.empty-title {
  margin: 0 0 0.4rem;
  font-size: 1rem;
  font-weight: 600;
  color: #e4e4e7;
}
.empty-sub {
  margin: 0 0 1.25rem;
  font-size: 0.875rem;
  color: #71717a;
}
.empty-cta {
  font-size: 0.875rem;
  color: #a78bfa;
  text-decoration: none;
}
.empty-cta:hover {
  text-decoration: underline;
}
.site-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.site-card {
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.site-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-weight: 600;
  color: #e4e4e7;
}
.site-url {
  font-size: 0.85rem;
  color: #a78bfa;
  text-decoration: none;
  word-break: break-all;
}
.site-url:hover {
  text-decoration: underline;
}
.site-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.meta-sep {
  font-size: 0.75rem;
  color: #3f3f46;
}
.meta-item {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.meta-label {
  font-size: 0.75rem;
  color: #52525b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.meta-value {
  font-size: 0.8rem;
  color: #71717a;
}
.danger-zone {
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  justify-content: center;
}
.clear-btn {
  padding: 0.45rem 1rem;
  font-size: 0.875rem;
  background: transparent;
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
  color: #f87171;
  cursor: pointer;
}
.clear-btn:hover {
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.5);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 100%;
  max-width: 360px;
  margin: 1rem;
  background: #1c1c1e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 1.5rem;
}
.modal-title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  font-weight: 600;
  color: #e4e4e7;
}
.modal-body {
  margin: 0 0 1.5rem;
  font-size: 0.875rem;
  color: #a1a1aa;
  line-height: 1.5;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
.modal-cancel {
  padding: 0.45rem 0.9rem;
  font-size: 0.875rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #a1a1aa;
  cursor: pointer;
}
.modal-cancel:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.3);
}
.modal-confirm {
  padding: 0.45rem 0.9rem;
  font-size: 0.875rem;
  background: rgba(248, 113, 113, 0.15);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 8px;
  color: #f87171;
  cursor: pointer;
}
.modal-confirm:hover {
  background: rgba(248, 113, 113, 0.25);
  border-color: rgba(248, 113, 113, 0.6);
}
</style>
