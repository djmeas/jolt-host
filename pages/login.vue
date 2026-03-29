<script setup lang="ts">
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

const { refresh } = useCurrentUser()

async function submit() {
  if (!email.value.trim() || !password.value) return
  error.value = null
  loading.value = true
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: email.value.trim(), password: password.value },
    })
    await refresh()
    await navigateTo('/dashboard')
  } catch (e: unknown) {
    const err = e as { status?: number; data?: { message?: string }; message?: string }
    if (err.status === 401) {
      error.value = 'Invalid email or password.'
    } else {
      error.value = err.data?.message ?? err.message ?? 'Login failed'
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Log in</h1>
      <form class="form" @submit.prevent="submit">
        <input
          v-model="email"
          type="email"
          class="form-input"
          placeholder="Email"
          autocomplete="email"
          :disabled="loading"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="form-input"
          placeholder="Password"
          autocomplete="current-password"
          :disabled="loading"
        />
        <button type="submit" class="submit-btn" :disabled="loading || !email.trim() || !password">
          {{ loading ? 'Logging in…' : 'Log in' }}
        </button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
      <p class="footer-link">
        Don't have an account?
        <NuxtLink to="/register" class="link">Register</NuxtLink>
      </p>
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
.form-input::placeholder {
  color: #71717a;
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
.footer-link {
  margin: 1.25rem 0 0;
  font-size: 0.9rem;
  color: #a1a1aa;
}
.link {
  color: #a78bfa;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}
.back-link {
  display: inline-block;
  margin-top: 1rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
</style>
