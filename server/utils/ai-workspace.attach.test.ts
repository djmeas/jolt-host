import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import unzipper from 'unzipper'
import {
  attachWorkspaceGeneration,
  buildWorkspaceZip,
  deleteWorkspaceForUser,
  discardSnapshot,
  getWorkspaceDir,
  loadPreEditSnapshot,
  readServedSiteFiles,
  stageSnapshotRestore,
  WorkspaceError,
  writePreEditSnapshot,
} from './ai-workspace'
import { getStorageDir } from './db'

const createdIds: string[] = []
const createdPaths: string[] = []

function newId(): string {
  const id = randomUUID()
  createdIds.push(id)
  return id
}

/** Creates a served site directory and returns its entry point (relative path). */
function writeSite(
  slug: string,
  files: { path: string; data: Buffer }[],
  entryRelative = 'index.html'
): { dir: string; entryPoint: string } {
  const dir = join(getStorageDir(), slug)
  mkdirSync(dir, { recursive: true })
  createdPaths.push(dir)
  for (const file of files) {
    const target = join(dir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
  return { dir, entryPoint: `${slug}/${entryRelative}` }
}

function catchWorkspaceError(run: () => unknown): WorkspaceError {
  try {
    run()
  } catch (error) {
    if (error instanceof WorkspaceError) return error
    throw error
  }
  throw new Error('Expected a WorkspaceError')
}

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    try {
      deleteWorkspaceForUser(id)
    } catch {
      // Best-effort cleanup of the shared test storage directory.
    }
  }
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('readServedSiteFiles', () => {
  it('reads the served root relative to the entry point', () => {
    const slug = `served-${randomUUID().slice(0, 8)}`
    const { entryPoint } = writeSite(slug, [
      { path: 'index.html', data: Buffer.from('<h1>hi</h1>') },
      { path: 'styles/site.css', data: Buffer.from('body{}') },
      { path: 'img/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) },
    ])

    const source = readServedSiteFiles(entryPoint)

    expect(source.entryFile).toBe('index.html')
    expect(source.entries.map((entry) => entry.path).sort()).toEqual(['img/logo.png', 'index.html', 'styles/site.css'])
  })

  it('seeds only the nested served root, not unservable files beside it', () => {
    const slug = `nested-${randomUUID().slice(0, 8)}`
    const segment = `u-${randomUUID().slice(0, 8)}`
    const outer = join(getStorageDir(), '.content', slug, segment)
    mkdirSync(join(outer, 'pages'), { recursive: true })
    createdPaths.push(join(getStorageDir(), '.content', slug))
    writeFileSync(join(outer, 'pages', 'index.html'), '<h1>nested</h1>')
    writeFileSync(join(outer, 'unserved.txt'), 'outside the served root')

    const source = readServedSiteFiles(`.content/${slug}/${segment}/pages/index.html`)

    expect(source.entryFile).toBe('index.html')
    expect(source.entries.map((entry) => entry.path)).toEqual(['index.html'])
  })

  it('accepts a Markdown entry point', () => {
    const slug = `md-${randomUUID().slice(0, 8)}`
    const { entryPoint } = writeSite(slug, [{ path: 'index.md', data: Buffer.from('# hi') }], 'index.md')

    const source = readServedSiteFiles(entryPoint)
    expect(source.entryFile).toBe('index.md')
    expect(source.entries.map((entry) => entry.path)).toEqual(['index.md'])
  })

  it('rejects unsafe layouts instead of silently dropping files', () => {
    const slug = `unsafe-${randomUUID().slice(0, 8)}`
    const { dir, entryPoint } = writeSite(slug, [{ path: 'index.html', data: Buffer.from('<h1>x</h1>') }])

    symlinkSync('/etc/hosts', join(dir, 'link.txt'))
    expect(catchWorkspaceError(() => readServedSiteFiles(entryPoint)).code).toBe('invalid_path')
    rmSync(join(dir, 'link.txt'))

    writeFileSync(join(dir, '%2e%2e'), 'bad name')
    expect(catchWorkspaceError(() => readServedSiteFiles(entryPoint)).code).toBe('invalid_path')
  })

  it('rejects an unusable entry point, a non-served root, and a non-editable entry', () => {
    const slug = `entry-${randomUUID().slice(0, 8)}`
    const { dir, entryPoint } = writeSite(slug, [{ path: 'index.html', data: Buffer.from('<h1>x</h1>') }])

    for (const bad of ['index.html', `../${entryPoint}`, `/abs/index.html`, `.staging/${slug}/index.html`]) {
      expect(catchWorkspaceError(() => readServedSiteFiles(bad)).code).toBe('invalid_path')
    }

    writeFileSync(join(dir, 'index.txt'), 'text')
    expect(catchWorkspaceError(() => readServedSiteFiles(`${slug}/index.txt`)).code).toBe('invalid_path')
  })
})

describe('pre-edit snapshots and restore', () => {
  it('writes one snapshot that restores the exact attached bytes into a new generation', () => {
    const userId = newId()
    const entries = [
      { path: 'index.html', data: Buffer.from('<h1>original</h1>') },
      { path: 'img/logo.png', data: Buffer.from([1, 2, 3, 4, 5]) },
    ]

    const snapshot = writePreEditSnapshot(userId, entries, 'index.html')
    expect(snapshot).toMatch(/^\.pre-edit-\d+$/)
    expect(existsSync(join(getWorkspaceDir(userId), snapshot, 'content', 'index.html'))).toBe(true)

    const loaded = loadPreEditSnapshot(userId, snapshot)
    expect(loaded.entryFile).toBe('index.html')
    expect(loaded.files.map((file) => file.path).sort()).toEqual(['img/logo.png', 'index.html'])

    const prepared = stageSnapshotRestore(userId, snapshot)
    expect(prepared.generation).not.toBeNull()
    const restoredHtml = readFileSync(
      join(getWorkspaceDir(userId), '.generations', prepared.generation!, 'content', 'index.html'),
      'utf8'
    )
    expect(restoredHtml).toBe('<h1>original</h1>')

    discardSnapshot(userId, snapshot)
    expect(existsSync(join(getWorkspaceDir(userId), snapshot))).toBe(false)
  })

  it('rejects an unknown or tampered snapshot directory', () => {
    const userId = newId()
    for (const bad of ['not-a-snapshot', '.pre-edit-123', '../escape']) {
      expect(catchWorkspaceError(() => loadPreEditSnapshot(userId, bad)).code).toBe('workspace_storage_failed')
    }
  })
})

describe('buildWorkspaceZip', () => {
  it('includes opaque assets byte-for-byte alongside editable text', async () => {
    const userId = newId()
    const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42])
    const prepared = attachWorkspaceGeneration(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>hi</h1>') },
        { path: 'img/logo.png', data: logo },
      ],
      'index.html'
    )

    const zip = await buildWorkspaceZip(userId, prepared.generation)
    const reader = (await unzipper.Open.buffer(zip)) as unknown as {
      files: { path: string; buffer: () => Promise<Buffer> }[]
    }
    expect(reader.files.map((file) => file.path).sort()).toEqual(['img/logo.png', 'index.html'])

    const stored = await reader.files.find((file) => file.path === 'img/logo.png')!.buffer()
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(logo).digest('hex'))
  })
})

describe('attach workspace limits', () => {
  it('refuses an over-count editable set with the attachment-specific code', () => {
    const userId = newId()
    const entries = [{ path: 'index.html', data: Buffer.from('x') }]
    for (let index = 0; index < 50; index += 1) {
      entries.push({ path: `page-${index}.html`, data: Buffer.from('x') })
    }

    const error = catchWorkspaceError(() => attachWorkspaceGeneration(userId, entries, 'index.html'))
    expect(error.code).toBe('editable_workspace_too_large')
    expect(error.statusCode).toBe(413)
  })

  it('refuses an oversized editable file', () => {
    const userId = newId()
    const error = catchWorkspaceError(() =>
      attachWorkspaceGeneration(
        userId,
        [
          { path: 'index.html', data: Buffer.from('x') },
          { path: 'big.txt', data: Buffer.alloc(1024 * 1024 + 1, 0x61) },
        ],
        'index.html'
      )
    )
    expect(error.code).toBe('editable_workspace_too_large')
  })

  it('bounds the source ceiling for every seeding path', () => {
    const userId = newId()
    const huge = Buffer.alloc(100 * 1024 * 1024 + 1, 0x61)
    const error = catchWorkspaceError(() =>
      attachWorkspaceGeneration(
        userId,
        [
          { path: 'index.html', data: Buffer.from('x') },
          { path: 'big.bin', data: huge },
        ],
        'index.html'
      )
    )
    expect(error.code).toBe('source_too_large')
    expect(error.statusCode).toBe(413)
    expect(existsSync(join(getWorkspaceDir(userId), '.generations'))).toBe(false)
  })
})
