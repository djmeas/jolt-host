<script setup lang="ts">
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

async function submit() {
  if (!password.value.trim()) return
  error.value = null
  loading.value = true
  try {
    await $fetch('/api/admin/login', {
      method: 'POST',
      body: { password: password.value },
    })
    await navigateTo('/admin')
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    error.value = err.data?.message ?? err.message ?? 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Admin login</h1>
      <form @submit.prevent="submit" class="form">
        <input
          v-model="password"
          type="password"
          class="form-input"
          placeholder="Password"
          autocomplete="current-password"
          :disabled="loading"
          autofocus
        />
        <button type="submit" class="submit-btn" :disabled="loading">
          {{ loading ? 'Logging in…' : 'Log in' }}
        </button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
      <NuxtLink to="/" class="back-link">← Back to home</NuxtLink>
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
  max-width: 360px;
  margin: 0 auto;
  padding: 2rem;
  background: #18181b;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
}
.title {
  margin: 0 0 1.5rem;
  font-size: 1.5rem;
  font-weight: 600;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.form-input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  font-size: 1rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
}
.form-input:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.submit-btn {
  padding: 0.65rem 1rem;
  font-size: 1rem;
  font-weight: 500;
  background: rgba(167, 139, 250, 0.25);
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
}
.submit-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.35);
}
.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.error {
  margin: 1rem 0 0;
  font-size: 0.9rem;
  color: #f87171;
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
