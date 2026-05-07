import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock $fetch before importing the composable
const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)

// We need to import after mocking
describe('useExpirationModal', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should be imported', async () => {
    const { useExpirationModal } = await import('./useExpirationModal')
    expect(useExpirationModal).toBeDefined()
  })

  it('initial state: modal closed, neverExpire checked, no date, no error', async () => {
    const { useExpirationModal } = await import('./useExpirationModal')
    const modal = useExpirationModal()

    expect(modal.isOpen.value).toBe(false)
    expect(modal.slug.value).toBeNull()
    expect(modal.neverExpire.value).toBe(true)
    expect(modal.expirationDate.value).toBe('')
    expect(modal.isLoading.value).toBe(false)
    expect(modal.error.value).toBeNull()
  })

  describe('open()', () => {
    it('opens the modal with the given slug', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')

      expect(modal.isOpen.value).toBe(true)
      expect(modal.slug.value).toBe('test-slug')
      expect(modal.neverExpire.value).toBe(true)
      expect(modal.error.value).toBeNull()
      expect(modal.isLoading.value).toBe(false)
    })

    it('pre-fills expiration date with a future date', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')

      expect(modal.expirationDate.value).not.toBe('')
      // Should be a valid datetime-local format: YYYY-MM-DDTHH:mm
      expect(modal.expirationDate.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)

      // Should be in the future
      const parsed = new Date(modal.expirationDate.value)
      expect(parsed.getTime()).toBeGreaterThan(Date.now())
    })

    it('resets error and loading state when opening', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      // Set some dirty state
      modal.error.value = 'Previous error'
      modal.isLoading.value = true

      modal.open('test-slug')

      expect(modal.error.value).toBeNull()
      expect(modal.isLoading.value).toBe(false)
    })
  })

  describe('close()', () => {
    it('closes the modal and resets all state', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      modal.neverExpire.value = false
      modal.error.value = 'Some error'
      modal.isLoading.value = true

      modal.close()

      expect(modal.isOpen.value).toBe(false)
      expect(modal.slug.value).toBeNull()
      expect(modal.neverExpire.value).toBe(true)
      expect(modal.expirationDate.value).toBe('')
      expect(modal.isLoading.value).toBe(false)
      expect(modal.error.value).toBeNull()
    })
  })

  describe('save()', () => {
    it('sends null expiresAt when neverExpire is true', async () => {
      mockFetch.mockResolvedValueOnce({})

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      await modal.save()

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/admin/upload/test-slug/expiration',
        {
          method: 'POST',
          body: { expiresAt: null },
        }
      )
    })

    it('sends ISO date when neverExpire is false and date is valid', async () => {
      mockFetch.mockResolvedValueOnce({})

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      modal.neverExpire.value = false
      modal.expirationDate.value = '2026-12-31T12:00'

      await modal.save()

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/admin/upload/test-slug/expiration',
        {
          method: 'POST',
          body: { expiresAt: new Date('2026-12-31T12:00').toISOString() },
        }
      )
    })

    it('sets error when date is empty and neverExpire is false', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      modal.neverExpire.value = false
      modal.expirationDate.value = ''

      await modal.save()

      expect(modal.error.value).toBe('Please select an expiration date')
      expect(modal.isLoading.value).toBe(false)
    })

    it('sets error when date is invalid', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      modal.neverExpire.value = false
      modal.expirationDate.value = 'not-a-date'

      await modal.save()

      expect(modal.error.value).toBe('Invalid date')
      expect(modal.isLoading.value).toBe(false)
    })

    it('sets error when date is in the past', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      modal.neverExpire.value = false
      modal.expirationDate.value = '2020-01-01T00:00'

      await modal.save()

      expect(modal.error.value).toBe('Expiration date must be in the future')
      expect(modal.isLoading.value).toBe(false)
    })

    it('sets loading state during save', async () => {
      mockFetch.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10)))

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      const savePromise = modal.save()

      expect(modal.isLoading.value).toBe(true)
      await savePromise
      expect(modal.isLoading.value).toBe(false)
    })

    it('sets error on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce({ data: { message: 'Server error' } })

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      await modal.save()

      expect(modal.error.value).toBe('Server error')
      expect(modal.isLoading.value).toBe(false)
    })

    it('sets generic error when fetch fails without message', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      await modal.save()

      expect(modal.error.value).toBe('Network error')
    })

    it('does nothing when slug is null', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      // Don't open the modal - slug stays null
      await modal.save()

      expect(mockFetch).not.toHaveBeenCalled()
      expect(modal.isLoading.value).toBe(false)
    })

    it('clears error on subsequent save attempt', async () => {
      mockFetch
        .mockRejectedValueOnce({ data: { message: 'First error' } })
        .mockResolvedValueOnce({})

      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      modal.open('test-slug')
      await modal.save()
      expect(modal.error.value).toBe('First error')

      // Second save should clear error before attempting
      await modal.save()
      expect(modal.error.value).toBeNull()
    })
  })

  describe('defaultExpirationDate()', () => {
    it('returns a date 24 hours in the future', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      const result = modal.defaultExpirationDate()
      const parsed = new Date(result)
      const now = new Date()

      // Should be roughly 24 hours ahead (within a few minutes tolerance)
      const diffHours = (parsed.getTime() - now.getTime()) / (1000 * 60 * 60)
      expect(diffHours).toBeGreaterThan(23)
      expect(diffHours).toBeLessThan(25)
    })

    it('returns correct datetime-local format', async () => {
      const { useExpirationModal } = await import('./useExpirationModal')
      const modal = useExpirationModal()

      const result = modal.defaultExpirationDate()
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    })
  })
})
