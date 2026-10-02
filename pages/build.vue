<script setup lang="ts">
import BuilderStudio from '~/components/BuilderStudio.vue'

/**
 * Builder Studio route.
 *
 * `/build` is the only builder UI route. `?edit=<slug>` only proposes a site to
 * attach; it grants no authorization and performs no request on its own.
 */
const route = useRoute()
const { data: siteConfig } = await useFetch('/api/config')
const { user, isLoggedIn, refresh } = useCurrentUser()

// The studio always needs a signed-in registered account, even in open
// publishing mode where the upload form does not.
if (!isLoggedIn.value) await refresh()

const accessError = computed(() => {
  if (!user.value) return 'Sign in with a registered account to use AI Builder.'
  if (!user.value.ai_build_enabled) return 'Build mode is not enabled for your account — ask an admin.'
  if (siteConfig.value?.aiBuilderAvailable === false) return 'AI Builder is not available on this server.'
  return null
})

/** `?edit=<slug>` only identifies a site to confirm; it grants no authorization. */
const editSlug = computed(() => (typeof route.query.edit === 'string' && route.query.edit ? route.query.edit : null))

useSeoMeta({
  title: 'Builder Studio',
  description:
    'Describe a static site in plain text and publish the generated files as a real hosted site you own.',
  ogTitle: 'Builder Studio',
  ogDescription:
    'Describe a static site in plain text and publish the generated files as a real hosted site you own.',
})
</script>

<template>
  <BuilderStudio v-if="!accessError" :edit-slug="editSlug" />
  <div v-else class="gate">
    <div class="gate-panel" role="status">
      <p class="gate-mark">&lt;jolt⚡&gt;</p>
      <h1 class="gate-title">Builder Studio</h1>
      <p class="gate-copy">{{ accessError }}</p>
      <div class="gate-actions">
        <NuxtLink v-if="!user" to="/login" class="gate-link gate-link-primary">Log in</NuxtLink>
        <NuxtLink
          v-if="!user && siteConfig?.registrationEnabled"
          to="/register"
          class="gate-link"
        >Create an account</NuxtLink>
        <NuxtLink to="/" class="gate-link">Back to home</NuxtLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.25rem;
  background: #0f0f12;
}
.gate-panel {
  width: 100%;
  max-width: 34rem;
  padding: 2rem;
  border: 1px solid #30303a;
  border-radius: 12px;
  background: #181820;
  text-align: left;
}
.gate-mark {
  margin: 0 0 0.75rem;
  font-family: 'Contrail One', sans-serif;
  font-size: 1.15rem;
  color: #a1a1aa;
}
.gate-title {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #f1f1f4;
}
.gate-copy {
  margin: 0 0 1.25rem;
  font-size: 0.9rem;
  line-height: 1.6;
  color: #a1a1aa;
  max-width: 52ch;
}
.gate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.gate-link {
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  padding: 0.55rem 1rem;
  border: 1px solid #30303a;
  border-radius: 8px;
  color: #e4e4e7;
}
.gate-link-primary {
  border-color: #a78bfa;
  background: rgba(167, 139, 250, 0.16);
  color: #ece7ff;
}
.gate-link:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}
</style>
