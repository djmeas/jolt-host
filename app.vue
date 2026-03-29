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

onMounted(() => {
  refresh()
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
      <nav class="navbar-nav">
        <template v-if="isLoggedIn">
          <span class="navbar-username" :title="user?.name">{{ user?.name }}</span>
          <NuxtLink to="/dashboard" class="navbar-nav-link">Dashboard</NuxtLink>
          <button type="button" class="navbar-logout-btn" @click="logout">Log out</button>
        </template>
        <template v-else>
          <NuxtLink to="/login" class="navbar-nav-link">Log in</NuxtLink>
          <NuxtLink to="/register" class="navbar-nav-link navbar-nav-link--accent">Register</NuxtLink>
        </template>
      </nav>
    </header>
    <main class="main" :class="{ 'main--full': isFullWidth }">
      <NuxtPage />
    </main>
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
</style>
