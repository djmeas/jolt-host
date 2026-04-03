<script setup lang="ts">
import { joinURL } from 'ufo'

const route = useRoute()
const isFullWidth = computed(() => ['/previewer', '/editor'].includes(route.path))
const runtimeConfig = useRuntimeConfig()
const logoUrl = computed(() => joinURL(runtimeConfig.app.baseURL, 'JoltSlashLogo.png'))

useHead({
  link: [
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Bungee&family=Contrail+One&display=swap',
    },
  ],
})

const { user, isLoggedIn, refresh } = useCurrentUser()
const { data: siteConfig } = await useFetch('/api/config')
const authEnabled = computed(() => siteConfig.value?.authEnabled ?? false)

const { sites, load: loadMySites } = useMySites()
const hasMySites = computed(() => sites.value.length > 0)

onMounted(() => {
  refresh()
  loadMySites()
})

async function logout() {
  try {
    await $fetch('/api/auth/logout', { method: 'POST' })
  } catch {}
  await refresh()
  await navigateTo('/')
}
</script>

<template>
  <Notivue v-slot="item">
    <Notification :item="item" />
  </Notivue>
  <ClientOnly><LightningBackground /></ClientOnly>
  <div class="app">
    <header class="navbar">
      <div class="navbar-left">
        <NuxtLink to="/" class="navbar-brand" aria-label="Jolt Host home">
          <!-- <img
            class="navbar-logo"
            :src="logoUrl"
            alt="Jolt Host"
            width="160"
            height="42"
          /> -->
          <span class="navbar-host">&lt;jolt⚡&gt; HOST</span>
        </NuxtLink>
        <ClientOnly>
          <NuxtLink v-if="hasMySites" to="/my-sites" class="navbar-nav-link">My Sites</NuxtLink>
        </ClientOnly>
      </div>
      <nav class="navbar-nav">
        <template v-if="isLoggedIn">
          <span class="navbar-username" :title="user?.name">{{ user?.name }}</span>
          <NuxtLink to="/dashboard" class="navbar-nav-link">Dashboard</NuxtLink>
          <button type="button" class="navbar-logout-btn" @click="logout">Log out</button>
        </template>
        <template v-else-if="authEnabled">
          <NuxtLink to="/login" class="navbar-nav-link">Log in</NuxtLink>
          <NuxtLink to="/register" class="navbar-nav-link navbar-nav-link--accent">Register</NuxtLink>
        </template>
      </nav>
    </header>
    <main class="main" :class="{ 'main--full': isFullWidth }">
      <NuxtPage />
    </main>
    <footer class="footer">
      <NuxtLink to="/how-to" class="footer-link">How to use</NuxtLink>
      <span class="footer-sep">·</span>
      <NuxtLink to="/privacy" class="footer-link">Privacy Policy</NuxtLink>
      <span class="footer-sep">·</span>
      <NuxtLink to="/terms" class="footer-link">Terms</NuxtLink>
      <span class="footer-sep">·</span>
      <a href="https://github.com/djmeas/jolt-host" target="_blank" rel="noopener" class="footer-github">
        <svg class="github-icon" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
            0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
            -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87
            2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
            0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21
            2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04
            2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82
            2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
            1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        GitHub
      </a>
    </footer>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: 'DM Sans', system-ui, sans-serif;
  background: linear-gradient(145deg, #0f0f12 0%, #1a1a22 100%);
  min-height: 100vh;
  color: #e4e4e7;
}
.app {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.navbar {
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.navbar-left {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.navbar-nav {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.navbar-username {
  font-size: 0.9rem;
  color: #a1a1aa;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.navbar-nav-link {
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  border: 1px solid transparent;
}
.navbar-nav-link:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.15);
}
.navbar-nav-link--accent {
  background: rgba(167, 139, 250, 0.15);
  border-color: rgba(167, 139, 250, 0.35);
  color: #c4b5fd;
}
.navbar-nav-link--accent:hover {
  background: rgba(167, 139, 250, 0.25);
  border-color: rgba(167, 139, 250, 0.5);
  color: #c4b5fd;
}
.navbar-logout-btn {
  padding: 0.3rem 0.6rem;
  font-size: 0.9rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.navbar-logout-btn:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.35);
}
.navbar-brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: #e4e4e7;
  text-decoration: none;
}
.navbar-brand:hover {
  color: #a78bfa;
}
.navbar-logo {
  display: block;
  height: 32px;
  width: auto;
  filter: drop-shadow(0 2px 12px rgba(0, 0, 0, 0.35));
}
.navbar-host {
  font-family: "Contrail One", sans-serif;
  font-weight: 200;
  font-style: normal;
  letter-spacing: 0.06em;
  line-height: 1;
  font-size: 18px;
}
.main {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  min-height: 0;
}
.main--full {
  padding: 0;
  align-items: stretch;
  justify-content: stretch;
}
.footer {
  padding: 1rem 1.5rem;
  text-align: center;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.footer-link {
  font-size: 0.8rem;
  color: #52525b;
  text-decoration: none;
}
.footer-link:hover {
  color: #a1a1aa;
}
.footer-sep {
  font-size: 0.8rem;
  color: #3f3f46;
}
.footer-github {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: #52525b;
  text-decoration: none;
}
.footer-github:hover {
  color: #a1a1aa;
}
.github-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
</style>
