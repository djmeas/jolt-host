<script setup lang="ts">
</script>

<template>
  <div class="app">
    <header class="navbar">
      <NuxtLink to="/" class="navbar-brand">Jolt Host ⚡️</NuxtLink>
    </header>
    <main class="main">
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
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.navbar {
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
  text-align: center;
}
.navbar-brand {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #e4e4e7;
  text-decoration: none;
}
.navbar-brand:hover {
  color: #a78bfa;
}
.main {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
</style>
