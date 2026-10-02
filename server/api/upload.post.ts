import { readMultipartFormData } from 'h3'
import { createUploadFromContent } from '~/server/utils/upload-publish'

/**
 * `POST /api/upload` is the multipart adapter for the shared creation pipeline.
 * It only turns the form into `CreateUploadInput`; every creation rule
 * (authorization, rate limit, CAPTCHA, password, expiration, size, canonical
 * URL, persistence, result shape) lives in `createUploadFromContent`.
 */
export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)

  const textField = (name: string): string | null => {
    const field = form?.find((part) => part.name === name && typeof part.data === 'object')
    return field?.data && Buffer.isBuffer(field.data) ? field.data.toString('utf8') : null
  }

  const file = form?.find((part) => part.name === 'file' || part.data)
  const fileData = file?.data ? (Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)) : null

  const enableDataRaw = textField('enable_data')
  const turnstilePart = form?.find((part) => part.name === 'cf-turnstile-response')

  return createUploadFromContent(event, {
    data: fileData,
    emptyForm: !form || form.length === 0,
    filename: file?.filename || 'file',
    password: textField('password') ?? '',
    expiration: textField('expiration') ?? '',
    title: textField('title'),
    enableData: enableDataRaw != null && ['true', '1', 'on', 'yes'].includes(enableDataRaw.trim().toLowerCase()),
    turnstileToken:
      turnstilePart?.data && Buffer.isBuffer(turnstilePart.data) ? turnstilePart.data.toString('utf8').trim() : '',
  })
})
