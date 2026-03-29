<script setup lang="ts">
const name = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

const { refresh } = useCurrentUser()

async function submit() {
  error.value = null
  if (!name.value.trim() || !email.value.trim() || !password.value) return
  if (password.value !== confirmPassword.value) {
    error.value = 'Passwords do not match.'
    return
  }
  loading.value = true
  try {
    await $fetch('/api/auth/register', {
      method: 'POST',
      body: { name: name.value.trim(), email: email.value.trim(), password: password.value },
    })
    await refresh()
    await navigateTo('/dashboard')
  } catch (e: unknown) {
    const err = e as { status?: number; data?: { message?: string }; message?: string }
    if (err.status === 409) {
      error.value = 'Email already in use.'
    } else if (err.status === 422) {
      error.value = err.data?.message ?? 'Validation error. Please check your inputs.'
    } else {
      error.value = err.data?.message ?? err.message ?? 'Registration failed.'
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="box">
      <h1 class="title">Create account</h1>
      <form class="form" @submit.prevent="submit">
        <input
          v-model="name"
          type="text"
          class="form-input"
          placeholder="Name"
          autocomplete="name"
          :disabled="loading"
          autofocus
        />
        <input
          v-model="email"
          type="email"
          class="form-input"
          placeholder="Email"
          autocomplete="email"
          :disabled="loading"
        />
        <input
          v-model="password"
          type="password"
          class="form-input"
          placeholder="Password"
          autocomplete="new-password"
          :disabled="loading"
        />
        <input
          v-model="confirmPassword"
          type="password"
          class="form-input"
          placeholder="Confirm password"
          autocomplete="new-password"
          :disabled="loading"
        />
        <button
          type="submit"
          class="submit-btn"
          :disabled="loading || !name.trim() || !email.trim() || !password || !confirmPassword"
        >
          {{ loading ? 'Creating account…' : 'Create account' }}
        </button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
      <p class="footer-link">
        Already have an account?
        <NuxtLink to="/login" class="link">Log in</NuxtLink>
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
