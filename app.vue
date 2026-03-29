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
  justify-content: center;
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
