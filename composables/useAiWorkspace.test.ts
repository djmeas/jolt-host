import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CHAT_MESSAGE_MAX_BYTES,
  countMessageBytes,
  describeAiError,
  readAiError,
  useAiWorkspace,
} from './useAiWorkspace'

// The request boundary is the only thing mocked: these tests cover state and
// error behavior that can regress independently of the Studio template.
const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)

const WORKSPACE = {
  revision: 3,
  entry_file: 'index.html',
  files: [{ path: 'index.html', bytes: 12, editable: true }],
  editable_files: 1,
  editable_bytes: 12,
  opaque_files: 0,
  opaque_bytes: 0,
  target: null,
  restore_available: false,
  messages: [],
}

const PREVIEW_RESULT = {
  slug: 'quick-apple-42',
  url: 'https://quick-apple-42.sites.example.net/',
  owner_token: 'owner-token-123',
  expires_at: '2026-10-02T00:00:00.000Z',
}

/** Boots the composable with a loaded, unattached workspace. */
async function loadWorkspace() {
  mockFetch.mockResolvedValueOnce(WORKSPACE)
  const workspace = useAiWorkspace()
  await workspace.load()
  return workspace
}

describe('readAiError / describeAiError', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sessionStorage.clear()
  })

  it('reads the documented error envelope plus the 429 retry window', () => {
    const info = readAiError({
      statusCode: 429,
      data: { error: { code: 'rate_limited', message: 'Too many requests' }, retry_after: 90 },
    })

    expect(info.code).toBe('rate_limited')
    expect(info.retryAfter).toBe(90)
    expect(describeAiError(info)).toBe(
      'You have reached the AI Builder request limit. Try again in 90 seconds.'
    )
  })

  it('reports a retry window of a minute or more in minutes', () => {
    const base = 'You have reached the AI Builder request limit.'
    expect(describeAiError({ code: 'rate_limited', message: 'Too many requests', retryAfter: 121 })).toBe(
      `${base} Try again in 3 minutes.`
    )
    expect(describeAiError({ code: 'rate_limited', message: 'Too many requests', retryAfter: 119 })).toBe(
      `${base} Try again in 119 seconds.`
    )
  })

  it('uses the actionable wording for known codes and the server message otherwise', () => {
    expect(describeAiError({ code: 'workspace_conflict', message: 'conflict', retryAfter: null })).toBe(
      'The workspace changed since this tab loaded. Refresh the workspace, then try again.'
    )
    expect(describeAiError({ code: 'target_forbidden', message: 'forbidden', retryAfter: null })).toBe(
      'You no longer have access to the attached site.'
    )
    expect(describeAiError({ code: 'unmapped_code', message: 'Server detail.', retryAfter: null })).toBe(
      'Server detail.'
    )
    expect(describeAiError({ code: null, message: 'Network down', retryAfter: null })).toBe('Network down')
  })

  it('falls back to a thrown error message when no envelope is present', () => {
    expect(describeAiError(readAiError(new Error('boom')))).toBe('boom')
    expect(describeAiError(readAiError(undefined))).toBe('Something went wrong.')
  })
})

describe('useAiWorkspace message byte bound', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sessionStorage.clear()
  })

  it('refuses an oversized draft without sending a paid chat request', async () => {
    const workspace = await loadWorkspace()

    const oversized = 'a'.repeat(CHAT_MESSAGE_MAX_BYTES + 1)
    const sent = await workspace.sendMessage(oversized)

    expect(sent).toBe(false)
    expect(workspace.errorCode.value).toBe('request_too_large')
    expect(workspace.errorMessage.value).toBe(
      `Your message is ${CHAT_MESSAGE_MAX_BYTES + 1} bytes; the limit is ${CHAT_MESSAGE_MAX_BYTES}. Shorten it and try again.`
    )
    // Only the workspace load reached the request boundary.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('counts multi-byte characters at their UTF-8 length', async () => {
    const workspace = await loadWorkspace()

    const emojiDraft = '⚡'.repeat(CHAT_MESSAGE_MAX_BYTES / 3 + 1)
    expect(countMessageBytes(emojiDraft)).toBe(emojiDraft.length * 3)

    const sent = await workspace.sendMessage(emojiDraft)
    expect(sent).toBe(false)
    expect(workspace.errorCode.value).toBe('request_too_large')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('useAiWorkspace publishPreview', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sessionStorage.clear()
  })

  it('keeps the creation result available for the Studio instead of navigating', async () => {
    const workspace = await loadWorkspace()
    mockFetch.mockResolvedValueOnce(PREVIEW_RESULT)

    const result = await workspace.publishPreview({
      title: 'My AI site',
      expiration: '1h',
      password: '',
      enableData: false,
    })

    expect(result).toEqual(PREVIEW_RESULT)
    expect(workspace.publishedResult.value?.slug).toBe('quick-apple-42')
    expect(workspace.errorMessage.value).toBeNull()
    // The result is saved for the result page, and no further request (a
    // navigation-triggering or automatic republish) was issued.
    expect(JSON.parse(sessionStorage.getItem('jolthost-result-quick-apple-42')!).slug).toBe('quick-apple-42')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('requires a password to enable the Data API and publishes nothing', async () => {
    const workspace = await loadWorkspace()

    const result = await workspace.publishPreview({
      title: '',
      expiration: '1h',
      password: '   ',
      enableData: true,
    })

    expect(result).toBeNull()
    expect(workspace.errorCode.value).toBe('invalid_request')
    expect(workspace.errorMessage.value).toBe(
      'The Data API requires a password — set one or untick “Enable Data API”.'
    )
    expect(workspace.publishedResult.value).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('never previews an attached workspace', async () => {
    mockFetch.mockResolvedValueOnce({
      ...WORKSPACE,
      target: { slug: 'attached-site', url: 'https://attached-site.sites.example.net/' },
    })
    const workspace = useAiWorkspace()
    await workspace.load()

    const result = await workspace.publishPreview({
      title: '',
      expiration: '1h',
      password: '',
      enableData: false,
    })

    expect(result).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
