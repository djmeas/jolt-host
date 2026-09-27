import { createWriteStream, mkdirSync } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { createError } from 'h3'
import unzipper from 'unzipper'

export const ACCEPTED_UPLOAD_EXTENSIONS = ['.html', '.zip', '.md'] as const

/** Upper bound on the total uncompressed size of a ZIP archive. */
export const ZIP_MAX_EXTRACTED_BYTES = 100 * 1024 * 1024

export function isAcceptedUploadFilename(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ACCEPTED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Resolves the effective upload size limit using the same policy as creation. */
export function resolveUploadMaxBytes(opts: {
  userMaxBytes?: number | null
  isApi: boolean
  isZip: boolean
  configMaxBytes: number
}): number {
  if (opts.userMaxBytes != null) return opts.userMaxBytes
  if (opts.isApi) return 100 * 1024 * 1024
  if (opts.isZip) return 5 * 1024 * 1024
  return opts.configMaxBytes
}

/** Picks the published entry file from a set of extracted paths (index.html first). */
export function pickEntryFile(paths: string[]): string | undefined {
  const htmlEntries = paths
    .filter((p) => p.toLowerCase().endsWith('.html'))
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
    .sort((a, b) => {
      if (a.toLowerCase() === 'index.html') return -1
      if (b.toLowerCase() === 'index.html') return 1
      return a.localeCompare(b)
    })
  return htmlEntries[0]
}

/** Normalises an archive entry path, returning null when it is unsafe. */
function safeRelativeEntryPath(entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return null
  if (normalized.split('/').some((segment) => segment === '..')) return null
  return normalized
}

/**
 * Extracts a ZIP archive into `targetDir`, rejecting entries that escape the
 * target directory and enforcing an extracted-size bound. Returns the relative
 * path of the HTML entry file.
 */
export async function extractZipSafely(buffer: Buffer, targetDir: string): Promise<string> {
  let directory: Awaited<ReturnType<typeof unzipper.Open.buffer>>
  try {
    directory = await unzipper.Open.buffer(buffer)
  } catch {
    throw createError({ statusCode: 400, message: 'Invalid or corrupted ZIP file.' })
  }

  const resolvedTarget = path.resolve(targetDir)
  const safeEntries: { entry: (typeof directory.files)[number]; relative: string }[] = []
  let totalUncompressed = 0

  for (const entry of directory.files) {
    const relative = safeRelativeEntryPath(entry.path)
    if (!relative) {
      throw createError({ statusCode: 400, message: 'ZIP contains an unsafe file path.' })
    }
    const dest = path.resolve(resolvedTarget, relative)
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw createError({ statusCode: 400, message: 'ZIP contains an unsafe file path.' })
    }
    if (entry.type !== 'Directory') {
      totalUncompressed += entry.uncompressedSize || 0
      if (totalUncompressed > ZIP_MAX_EXTRACTED_BYTES) {
        throw createError({ statusCode: 413, message: 'ZIP expands to too much data.' })
      }
    }
    safeEntries.push({ entry, relative })
  }

  const entryFile = pickEntryFile(safeEntries.filter((e) => e.entry.type !== 'Directory').map((e) => e.relative))
  if (!entryFile) {
    throw createError({ statusCode: 400, message: 'ZIP must contain at least one .html file' })
  }

  mkdirSync(resolvedTarget, { recursive: true })
  for (const { entry, relative } of safeEntries) {
    const dest = path.resolve(resolvedTarget, relative)
    if (entry.type === 'Directory') {
      mkdirSync(dest, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(dest), { recursive: true })
    await pipeline(entry.stream(), createWriteStream(dest))
  }

  return entryFile
}

/**
 * Writes an uploaded `.html`/`.md` file, or extracts a `.zip`, into `targetDir`.
 * Returns the entry file path relative to `targetDir`.
 */
export async function writeUploadContent(data: Buffer, filename: string, targetDir: string): Promise<string> {
  const lower = filename.toLowerCase()
  mkdirSync(targetDir, { recursive: true })
  if (lower.endsWith('.html')) {
    await pipeline(Readable.from(data), createWriteStream(path.join(targetDir, 'index.html')))
    return 'index.html'
  }
  if (lower.endsWith('.md')) {
    await pipeline(Readable.from(data), createWriteStream(path.join(targetDir, 'index.md')))
    return 'index.md'
  }
  return await extractZipSafely(data, targetDir)
}
