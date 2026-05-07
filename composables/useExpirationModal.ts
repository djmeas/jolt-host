import { ref } from 'vue'

export function useExpirationModal() {
  const isOpen = ref(false)
  const slug = ref<string | null>(null)
  const neverExpire = ref(true)
  const expirationDate = ref('')
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  function defaultExpirationDate() {
    const now = new Date()
    now.setDate(now.getDate() + 1)
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
    return now.toISOString().slice(0, 16)
  }

  function open(s: string) {
    slug.value = s
    neverExpire.value = true
    expirationDate.value = defaultExpirationDate()
    isLoading.value = false
    error.value = null
    isOpen.value = true
  }

  function close() {
    isOpen.value = false
    slug.value = null
    neverExpire.value = true
    expirationDate.value = ''
    isLoading.value = false
    error.value = null
  }

  async function save() {
    if (!slug.value) return
    error.value = null
    isLoading.value = true
    try {
      let expiresAt: string | null = null
      if (!neverExpire.value) {
        if (!expirationDate.value) {
          throw new Error('Please select an expiration date')
        }
        const date = new Date(expirationDate.value)
        if (isNaN(date.getTime())) {
          throw new Error('Invalid date')
        }
        if (date.getTime() <= Date.now()) {
          throw new Error('Expiration date must be in the future')
        }
        expiresAt = date.toISOString()
      }
      await $fetch(`/api/admin/upload/${slug.value}/expiration`, {
        method: 'POST',
        body: { expiresAt },
      })
      close()
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      error.value = err.data?.message ?? err.message ?? 'Failed to update expiration'
    } finally {
      isLoading.value = false
    }
  }

  return {
    isOpen,
    slug,
    neverExpire,
    expirationDate,
    isLoading,
    error,
    open,
    close,
    save,
    defaultExpirationDate,
  }
}
