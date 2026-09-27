import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isAcceptedUploadFilename,
  resolveUploadMaxBytes,
  pickEntryFile,
  writeUploadContent,
} from './upload-content'

describe('isAcceptedUploadFilename', () => {
  it.each(['a.html', 'A.HTML', 'site.zip', 'notes.md'])('accepts %s', (name) => {
    expect(isAcceptedUploadFilename(name)).toBe(true)
  })

  it.each(['a.txt', 'a.html.zip.exe', 'noext'])('rejects %s', (name) => {
    expect(isAcceptedUploadFilename(name)).toBe(false)
  })
})

describe('resolveUploadMaxBytes', () => {
  it('prefers the per-user limit', () => {
    expect(resolveUploadMaxBytes({ userMaxBytes: 1234, isApi: true, isZip: true, configMaxBytes: 999 })).toBe(1234)
  })

  it('gives API uploads 100MB', () => {
    expect(resolveUploadMaxBytes({ userMaxBytes: null, isApi: true, isZip: false, configMaxBytes: 1 })).toBe(100 * 1024 * 1024)
  })

  it('caps anonymous ZIP uploads at 5MB', () => {
    expect(resolveUploadMaxBytes({ userMaxBytes: null, isApi: false, isZip: true, configMaxBytes: 1 })).toBe(5 * 1024 * 1024)
  })

  it('falls back to the config limit', () => {
    expect(resolveUploadMaxBytes({ userMaxBytes: null, isApi: false, isZip: false, configMaxBytes: 777 })).toBe(777)
  })
})

describe('pickEntryFile', () => {
  it('prefers index.html', () => {
    expect(pickEntryFile(['about.html', 'index.html', 'z.html'])).toBe('index.html')
  })

  it('normalises backslashes and leading slashes', () => {
    expect(pickEntryFile(['/pages\\home.html'])).toBe('pages/home.html')
  })

  it('picks alphabetically otherwise', () => {
    expect(pickEntryFile(['b.html', 'a.html'])).toBe('a.html')
  })

  it('returns undefined with no HTML', () => {
    expect(pickEntryFile(['style.css'])).toBeUndefined()
  })
})

describe('writeUploadContent', () => {
  function tempDir() {
    return mkdtempSync(join(tmpdir(), 'jolt-content-'))
  }

  it('writes an html file as index.html', async () => {
    const dir = tempDir()
    try {
      const entry = await writeUploadContent(Buffer.from('<h1>hi</h1>'), 'index.html', dir)
      expect(entry).toBe('index.html')
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('hi')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes a markdown file as index.md', async () => {
    const dir = tempDir()
    try {
      expect(await writeUploadContent(Buffer.from('# hi'), 'notes.md', dir)).toBe('index.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a corrupted zip', async () => {
    const dir = tempDir()
    try {
      await expect(writeUploadContent(Buffer.from('not a zip'), 'site.zip', dir)).rejects.toMatchObject({ statusCode: 400 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not write outside the target directory for a path-escaping zip', async () => {
    const dir = tempDir()
    const outside = join(dir, '..', `escaped-${Date.now()}.txt`)
    try {
      const { readFileSync: readFixture } = await import('fs')
      const zip = readFixture(join(process.cwd(), 'test', 'fixtures', 'escape-site.zip'))
      await expect(writeUploadContent(zip, 'escape-site.zip', dir)).rejects.toMatchObject({ statusCode: 400 })
      expect(existsSync(outside)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (existsSync(outside)) rmSync(outside)
    }
  })
})
