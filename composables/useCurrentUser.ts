export const useCurrentUser = () => {
  const user = useState<{ id: string, name: string, email: string, upload_max_bytes: number | null, never_expire: number } | null>('currentUser', () => null)
  const pending = ref(false)

  const refresh = async () => {
    pending.value = true
    try {
      const data = await $fetch<{ id: string, name: string, email: string, upload_max_bytes: number | null, never_expire: number, created_at: string }>('/api/auth/me')
      user.value = data
    } catch {
      user.value = null
    } finally {
      pending.value = false
    }
  }

  const isLoggedIn = computed(() => user.value !== null)

  return { user, isLoggedIn, pending, refresh }
}
