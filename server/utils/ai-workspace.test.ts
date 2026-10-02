import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_MAX_FILE_BYTES,
  AI_MAX_WORKSPACE_BYTES,
  AI_MAX_WORKSPACE_FILES,
  WorkspaceError,
  type WorkspaceOperation,
  applyWorkspaceGeneration,
  commitPreparedGeneration,
  deleteWorkspaceForUser,
  describeWorkspace,
  getWorkspaceDir,
  isEditableWorkspacePath,
  pruneWorkspaceGenerations,
  readWorkspaceFile,
  stageWorkspaceGeneration,
  validateWorkspacePath,
  writeWorkspaceGeneration,
} from './ai-workspace'
import {
  deleteAiDataForUser,
  deleteUser,
  finalizeAiTurnError,
  finalizeAiTurnSuccess,
  getAiConversationTurns,
  getAiMessages,
  getAiWorkspace,
  getDbPath,
  getOrCreateAiWorkspace,
  insertAiTurnPending,
  insertUser,
  truncateUtf8Bytes,
} from './db'

const createdUsers: string[] = []

function createUser(): string {
  const id = randomUUID()
  insertUser(id, 'Workspace Test', `${id}@example.test`, 'hash')
  createdUsers.push(id)
  return id
}

/** Runs an operation and returns the WorkspaceError it raised. */
function catchWorkspaceError(run: () => unknown): WorkspaceError {
  try {
    run()
  } catch (error) {
    if (error instanceof WorkspaceError) return error
    throw error
  }
  throw new Error('Expected a WorkspaceError')
}

function generationContentDir(userId: string, generation: string): string {
  return join(getWorkspaceDir(userId), '.generations', generation, 'content')
}

function generationNames(userId: string): string[] {
  const dir = join(getWorkspaceDir(userId), '.generations')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

function seedWorkspace(userId: string, entries: { path: string; data: Buffer }[], entryFile: string) {
  const workspace = getOrCreateAiWorkspace(userId)
  if (!workspace) throw new Error('Expected a workspace row')
  const prepared = writeWorkspaceGeneration(userId, entries, entryFile)
  expect(commitPreparedGeneration(userId, prepared, workspace.revision, workspace.current_generation)).toBe(true)
  return prepared
}

afterEach(() => {
  for (const id of createdUsers.splice(0)) {
    try {
      deleteAiDataForUser(id)
    } catch {
      // Rows may already be gone when a test deletes the account itself.
    }
    deleteUser(id)
    try {
      deleteWorkspaceForUser(id)
    } catch {
      // Best-effort filesystem cleanup for the shared test storage directory.
    }
  }
})

describe('validateWorkspacePath', () => {
  it('accepts ordinary relative content paths', () => {
    for (const path of ['index.html', 'styles/site.css', 'a_b/c-d.e.json', 'deep/nested/dir/page.md', 'README.md']) {
      expect(validateWorkspacePath(path)).toBe(path)
    }
  })

  it('rejects every unsafe or ambiguous path shape', () => {
    const longSegment = 'a'.repeat(101)
    const longPath = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('/')
    const rejected: unknown[] = [
      '',
      undefined,
      null,
      42,
      '/index.html',
      'index.html/',
      'a//b',
      './index.html',
      'a/./b',
      '../index.html',
      'a/../../etc/passwd',
      String.raw`a\b.html`,
      'C:/index.html',
      'a:b.html',
      'a/b:c.html',
      '.hidden/x.html',
      'a/.git/config',
      '%2e%2e/x.html',
      'a\u0000b.html',
      'a\nb.html',
      longSegment,
      longPath,
      '_jolt/x.html',
      'api/x.html',
      'dashboard',
      'admin/x.html',
      'data/x.json',
    ]
    for (const path of rejected) {
      expect(catchWorkspaceError(() => validateWorkspacePath(path)).code).toBe('invalid_path')
    }
  })

  it('rejects a Windows drive letter even with a nested path', () => {
    expect(catchWorkspaceError(() => validateWorkspacePath('C:index.html')).code).toBe('invalid_path')
  })

  it('classifies editable extensions case-insensitively and rejects others', () => {
    expect(isEditableWorkspacePath('Index.HTML')).toBe(true)
    expect(isEditableWorkspacePath('styles/site.CSS')).toBe(true)
    expect(isEditableWorkspacePath('readme.md')).toBe(true)
    expect(isEditableWorkspacePath('logo.png')).toBe(false)
    expect(isEditableWorkspacePath('archive.zip')).toBe(false)
    expect(isEditableWorkspacePath('noextension')).toBe(false)
    expect(isEditableWorkspacePath('dir.html/script')).toBe(false)
  })
})

describe('workspace seeding and reads', () => {
  it('writes a generation and reads its exact editable content back', () => {
    const userId = createUser()
    const html = '<!doctype html><h1>Hello</h1>'
    const prepared = seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from(html) },
        { path: 'styles/site.css', data: Buffer.from('body{color:red}') },
      ],
      'index.html'
    )

    expect(prepared.files.map((file) => file.path)).toEqual(['index.html', 'styles/site.css'])
    expect(prepared.editableFiles).toBe(2)
    expect(prepared.editableBytes).toBe(Buffer.byteLength(html) + Buffer.byteLength('body{color:red}'))

    const described = describeWorkspace(userId, prepared.generation)
    expect(described).toMatchObject({
      generation: prepared.generation,
      entryFile: 'index.html',
      editableFiles: 2,
      opaqueFiles: 0,
    })

    const read = readWorkspaceFile(userId, prepared.generation, 'index.html')
    expect(read).toEqual({ path: 'index.html', content: html, bytes: Buffer.byteLength(html) })
  })

  it('classifies binary or NUL-carrying files as opaque regardless of extension', () => {
    const userId = createUser()
    const prepared = seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>x</h1>') },
        { path: 'images/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { path: 'logo.html', data: Buffer.from([0x01, 0x00, 0x02]) },
      ],
      'index.html'
    )

    expect(prepared.editableFiles).toBe(1)
    expect(prepared.opaqueFiles).toBe(2)
    expect(prepared.files.filter((file) => !file.editable).map((file) => file.path)).toEqual([
      'images/logo.png',
      'logo.html',
    ])

    const opaque = catchWorkspaceError(() => readWorkspaceFile(userId, prepared.generation, 'logo.html'))
    expect(opaque.code).toBe('opaque_file')
    expect(opaque.statusCode).toBe(403)
  })

  it('supports a Markdown entry file and rejects an unusable entry', () => {
    const userId = createUser()
    const prepared = seedWorkspace(userId, [{ path: 'notes.md', data: Buffer.from('# Notes') }], 'notes.md')
    expect(prepared.entryFile).toBe('notes.md')

    const missing = catchWorkspaceError(() =>
      writeWorkspaceGeneration(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'notes.md')
    )
    expect(missing.code).toBe('invalid_manifest')

    const unsupported = catchWorkspaceError(() =>
      writeWorkspaceGeneration(userId, [{ path: 'index.txt', data: Buffer.from('x') }], 'index.txt')
    )
    expect(unsupported.code).toBe('invalid_manifest')
  })

  it('refuses to read files that do not exist or that have invalid paths', () => {
    const userId = createUser()
    const prepared = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')

    expect(catchWorkspaceError(() => readWorkspaceFile(userId, prepared.generation, 'missing.html')).code).toBe(
      'file_not_found'
    )
    expect(catchWorkspaceError(() => readWorkspaceFile(userId, null, 'index.html')).code).toBe('file_not_found')
    expect(catchWorkspaceError(() => readWorkspaceFile(userId, prepared.generation, '../index.html')).code).toBe(
      'invalid_path'
    )
  })
})

describe('workspace quotas', () => {
  function filesWithTotal(totalBytes: number, fileBytes: number): { path: string; data: Buffer }[] {
    const entries: { path: string; data: Buffer }[] = [{ path: 'index.html', data: Buffer.from('x') }]
    let remaining = totalBytes
    let index = 0
    while (remaining > 0) {
      const size = Math.min(fileBytes, remaining)
      entries.push({ path: `part-${index}.txt`, data: Buffer.alloc(size, 0x61) })
      remaining -= size
      index += 1
    }
    return entries
  }

  it('accepts the inclusive file-count boundary and rejects one over', () => {
    const userId = createUser()
    const exactly: { path: string; data: Buffer }[] = [{ path: 'index.html', data: Buffer.from('x') }]
    for (let index = 1; index < AI_MAX_WORKSPACE_FILES; index += 1) {
      exactly.push({ path: `page-${index}.html`, data: Buffer.from('x') })
    }
    const prepared = writeWorkspaceGeneration(userId, exactly, 'index.html')
    expect(prepared.editableFiles).toBe(AI_MAX_WORKSPACE_FILES)

    exactly.push({ path: 'one-too-many.html', data: Buffer.from('x') })
    const over = catchWorkspaceError(() => writeWorkspaceGeneration(userId, exactly, 'index.html'))
    expect(over.code).toBe('workspace_limit_exceeded')
    expect(over.statusCode).toBe(413)
  })

  it('accepts the inclusive per-file boundary and rejects one byte over', () => {
    const userId = createUser()
    const prepared = writeWorkspaceGeneration(
      userId,
      [
        { path: 'index.html', data: Buffer.from('x') },
        { path: 'big.txt', data: Buffer.alloc(AI_MAX_FILE_BYTES, 0x61) },
      ],
      'index.html'
    )
    expect(prepared.editableBytes).toBe(AI_MAX_FILE_BYTES + 1)

    const over = catchWorkspaceError(() =>
      writeWorkspaceGeneration(
        userId,
        [
          { path: 'index.html', data: Buffer.from('x') },
          { path: 'big.txt', data: Buffer.alloc(AI_MAX_FILE_BYTES + 1, 0x61) },
        ],
        'index.html'
      )
    )
    expect(over.code).toBe('workspace_limit_exceeded')
  })

  it('accepts the inclusive workspace total and rejects one byte over', () => {
    const userId = createUser()
    // Four full files plus index.html reach exactly the total ceiling.
    const exact = filesWithTotal(AI_MAX_WORKSPACE_BYTES - 1, AI_MAX_FILE_BYTES)
    const prepared = writeWorkspaceGeneration(userId, exact, 'index.html')
    expect(prepared.editableBytes).toBe(AI_MAX_WORKSPACE_BYTES)

    const over = filesWithTotal(AI_MAX_WORKSPACE_BYTES, AI_MAX_FILE_BYTES)
    const rejected = catchWorkspaceError(() => writeWorkspaceGeneration(userId, over, 'index.html'))
    expect(rejected.code).toBe('workspace_limit_exceeded')
  })

  it('applies the same quota to a patch turn', () => {
    const userId = createUser()
    const prepared = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')

    const over = catchWorkspaceError(() =>
      applyWorkspaceGeneration(userId, {
        expectedRevision: 1,
        expectedGeneration: prepared.generation,
        operations: [{ op: 'add', path: 'big.txt', content: 'a'.repeat(AI_MAX_FILE_BYTES + 1) }],
      })
    )
    expect(over.code).toBe('workspace_limit_exceeded')
    expect(generationNames(userId)).toEqual([prepared.generation!])
  })
})

describe('workspace patch turns', () => {
  it('applies add, update, and delete to a fresh generation', () => {
    const userId = createUser()
    const first = applyWorkspaceGeneration(userId, {
      expectedRevision: 0,
      expectedGeneration: null,
      operations: [
        { op: 'add', path: 'index.html', content: '<h1>one</h1>' },
        { op: 'add', path: 'styles/site.css', content: 'body{}' },
      ],
    })
    expect(first.files.map((file) => file.path)).toEqual(['index.html', 'styles/site.css'])

    const second = applyWorkspaceGeneration(userId, {
      expectedRevision: 1,
      expectedGeneration: first.generation,
      operations: [
        { op: 'update', path: 'index.html', content: '<h1>two</h1>' },
        { op: 'add', path: 'scripts/site.js', content: 'console.log(1)' },
        { op: 'delete', path: 'styles/site.css' },
      ],
    })

    expect(second.files.map((file) => file.path)).toEqual(['index.html', 'scripts/site.js'])
    expect(readWorkspaceFile(userId, second.generation, 'index.html').content).toBe('<h1>two</h1>')
    expect(getAiWorkspace(userId)?.revision).toBe(2)
    expect(generationNames(userId)).toEqual([second.generation!])
    expect(existsSync(generationContentDir(userId, first.generation!))).toBe(false)
  })

  it('carries opaque assets through every generation byte-for-byte', () => {
    const userId = createUser()
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])
    const seeded = seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>x</h1>') },
        { path: 'images/logo.png', data: binary },
      ],
      'index.html'
    )

    const patched = applyWorkspaceGeneration(userId, {
      expectedRevision: 1,
      expectedGeneration: seeded.generation,
      operations: [{ op: 'add', path: 'styles/site.css', content: 'body{}' }],
    })

    expect(patched.files.map((file) => file.path)).toEqual(['images/logo.png', 'index.html', 'styles/site.css'])
    expect(patched.opaqueFiles).toBe(1)
    expect(readFileSync(join(generationContentDir(userId, patched.generation!), 'images/logo.png'))).toEqual(binary)
  })

  it('rejects operations against opaque assets and their case-folded names', () => {
    const userId = createUser()
    const seeded = seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>x</h1>') },
        { path: 'images/Logo.HTML', data: Buffer.from([0x00, 0x01]) },
      ],
      'index.html'
    )

    for (const operations of [
      [{ op: 'delete' as const, path: 'images/Logo.HTML' }],
      [{ op: 'update' as const, path: 'images/Logo.HTML', content: 'x' }],
      [{ op: 'add' as const, path: 'images/logo.html', content: 'x' }],
    ]) {
      const error = catchWorkspaceError(() =>
        applyWorkspaceGeneration(userId, {
          expectedRevision: 1,
          expectedGeneration: seeded.generation,
          operations,
        })
      )
      expect(error.code).toBe('invalid_manifest')
      expect(error.statusCode).toBe(502)
    }
    expect(generationNames(userId)).toEqual([seeded.generation!])
  })

  it('rejects malformed or contradictory operations without touching state', () => {
    const userId = createUser()
    const seeded = seedWorkspace(
      userId,
      [
        { path: 'index.html', data: Buffer.from('<h1>x</h1>') },
        { path: 'about.html', data: Buffer.from('<h1>about</h1>') },
      ],
      'index.html'
    )
    const rejected: unknown[][] = [
      [{ op: 'add', path: 'About.html', content: 'x' }],
      [{ op: 'add', path: 'index.html', content: 'x' }],
      [{ op: 'update', path: 'missing.html', content: 'x' }],
      [{ op: 'delete', path: 'missing.html' }],
      [{ op: 'delete', path: 'about.html', content: 'x' }],
      [{ op: 'replace', path: 'about.html', content: 'x' }],
      [{ op: 'add', path: 'logo.png', content: 'x' }],
      [{ op: 'add', path: 'index.html/sub.html', content: 'x' }],
      [
        { op: 'update', path: 'about.html', content: 'a' },
        { op: 'update', path: 'about.html', content: 'b' },
      ],
      [{ op: 'delete', path: 'index.html' }],
      [{ op: 'add', path: '_jolt/data.json', content: '{}' }],
      [{ op: 'update', path: '../escape.html', content: 'x' }],
    ]

    for (const operations of rejected) {
      // Deliberately malformed shapes: the runtime validator must reject them.
      const malformed = operations as WorkspaceOperation[]
      const error = catchWorkspaceError(() =>
        applyWorkspaceGeneration(userId, {
          expectedRevision: 1,
          expectedGeneration: seeded.generation,
          operations: malformed,
        })
      )
      expect(error.code).toBe('invalid_manifest')
    }
    expect(generationNames(userId)).toEqual([seeded.generation!])
    expect(readWorkspaceFile(userId, seeded.generation, 'index.html').content).toBe('<h1>x</h1>')
  })

  it('requires a new site to create index.html', () => {
    const userId = createUser()
    const error = catchWorkspaceError(() =>
      applyWorkspaceGeneration(userId, {
        expectedRevision: 0,
        expectedGeneration: null,
        operations: [{ op: 'add', path: 'styles/site.css', content: 'body{}' }],
      })
    )
    expect(error.code).toBe('invalid_manifest')
    expect(getAiWorkspace(userId)?.revision).toBe(0)
    expect(generationNames(userId)).toEqual([])
  })

  it('leaves committed bytes and revision untouched when the revision is stale', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>x</h1>') }], 'index.html')

    const conflict = catchWorkspaceError(() =>
      applyWorkspaceGeneration(userId, {
        expectedRevision: 0,
        expectedGeneration: null,
        operations: [{ op: 'update', path: 'index.html', content: 'other' }],
      })
    )

    expect(conflict.code).toBe('workspace_conflict')
    expect(getAiWorkspace(userId)?.revision).toBe(1)
    expect(generationNames(userId)).toEqual([seeded.generation!])
    expect(readWorkspaceFile(userId, seeded.generation, 'index.html').content).toBe('<h1>x</h1>')
  })

  it('reports a storage failure without publishing a partial generation', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('<h1>x</h1>') }], 'index.html')
    // A file where the staging directory must be makes the write fail.
    writeFileSync(join(getWorkspaceDir(userId), '.staging'), 'not a directory')

    const error = catchWorkspaceError(() =>
      applyWorkspaceGeneration(userId, {
        expectedRevision: 1,
        expectedGeneration: seeded.generation,
        operations: [{ op: 'update', path: 'index.html', content: 'never published' }],
      })
    )

    rmSync(join(getWorkspaceDir(userId), '.staging'), { force: true })
    expect(error.code).toBe('workspace_storage_failed')
    expect(getAiWorkspace(userId)?.revision).toBe(1)
    expect(generationNames(userId)).toEqual([seeded.generation!])
    expect(readWorkspaceFile(userId, seeded.generation, 'index.html').content).toBe('<h1>x</h1>')
  })

  it('refuses to stage when the workspace row is missing', () => {
    const userId = createUser()
    deleteAiDataForUser(userId)
    deleteUser(userId)

    const error = catchWorkspaceError(() =>
      applyWorkspaceGeneration(userId, {
        expectedRevision: 0,
        expectedGeneration: null,
        operations: [{ op: 'add', path: 'index.html', content: 'x' }],
      })
    )
    expect(error.code).toBe('user_missing')
  })
})

describe('workspace storage safety', () => {
  it('rejects a symbolic link inside a committed generation', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')
    symlinkSync('/etc/passwd', join(generationContentDir(userId, seeded.generation!), 'link.html'))

    const error = catchWorkspaceError(() => describeWorkspace(userId, seeded.generation))
    expect(error.code).toBe('workspace_storage_failed')
  })

  it('rejects content that metadata does not describe', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')
    writeFileSync(join(generationContentDir(userId, seeded.generation!), 'extra.html'), 'sneaky')

    expect(catchWorkspaceError(() => describeWorkspace(userId, seeded.generation)).code).toBe(
      'workspace_storage_failed'
    )
  })

  it('rejects metadata that is not a regular server-written file', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')
    const metadataPath = join(getWorkspaceDir(userId), '.generations', seeded.generation!, 'metadata.json')
    rmSync(metadataPath)
    symlinkSync('/etc/passwd', metadataPath)

    expect(catchWorkspaceError(() => describeWorkspace(userId, seeded.generation)).code).toBe(
      'workspace_storage_failed'
    )

    rmSync(metadataPath)
    writeFileSync(metadataPath, JSON.stringify({ generation: seeded.generation, entry_file: 'index.html', files: [] }))
    expect(catchWorkspaceError(() => describeWorkspace(userId, seeded.generation)).code).toBe(
      'workspace_storage_failed'
    )
  })

  it('never follows a symlinked generation directory', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)
    const target = randomUUID()
    mkdirSync(join(getWorkspaceDir(userId), '.generations'), { recursive: true })
    symlinkSync('/etc', join(getWorkspaceDir(userId), '.generations', target))

    expect(workspace?.current_generation).toBeNull()
    expect(catchWorkspaceError(() => describeWorkspace(userId, target)).code).toBe('workspace_storage_failed')
  })

  it('keeps the active generation and snapshot while pruning abandoned state', () => {
    const userId = createUser()
    const seeded = seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')
    const staleGeneration = randomUUID()
    mkdirSync(join(getWorkspaceDir(userId), '.generations', staleGeneration), { recursive: true })
    mkdirSync(join(getWorkspaceDir(userId), '.staging', 'abandoned'), { recursive: true })
    const activeSnapshot = '.pre-edit-1700000000000'
    mkdirSync(join(getWorkspaceDir(userId), activeSnapshot), { recursive: true })
    mkdirSync(join(getWorkspaceDir(userId), '.pre-edit-1600000000000'), { recursive: true })

    pruneWorkspaceGenerations(userId, seeded.generation, activeSnapshot)

    expect(generationNames(userId)).toEqual([seeded.generation!])
    expect(existsSync(join(getWorkspaceDir(userId), '.staging'))).toBe(false)
    expect(existsSync(join(getWorkspaceDir(userId), activeSnapshot))).toBe(true)
    expect(existsSync(join(getWorkspaceDir(userId), '.pre-edit-1600000000000'))).toBe(false)
  })

  it('removes the whole workspace for an account', () => {
    const userId = createUser()
    seedWorkspace(userId, [{ path: 'index.html', data: Buffer.from('x') }], 'index.html')
    expect(existsSync(getWorkspaceDir(userId))).toBe(true)

    deleteWorkspaceForUser(userId)

    expect(existsSync(getWorkspaceDir(userId))).toBe(false)
  })
})

describe('account deletion', () => {
  it('cannot be resurrected by a late prepared generation', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const prepared = stageWorkspaceGeneration(userId, describeWorkspace(userId, null), [
      { op: 'add', path: 'index.html', content: '<h1>x</h1>' },
    ])
    expect(generationNames(userId)).toContain(prepared.generation!)

    deleteAiDataForUser(userId)
    deleteUser(userId)

    expect(commitPreparedGeneration(userId, prepared, workspace.revision, workspace.current_generation)).toBe(false)
    expect(getAiWorkspace(userId)).toBeNull()
    expect(getOrCreateAiWorkspace(userId)).toBeNull()
    expect(generationNames(userId)).not.toContain(prepared.generation!)
  })

  it('removes transcript rows and the workspace row together', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const turnId = randomUUID()
    insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: 'hello' })
    finalizeAiTurnSuccess({
      turnId,
      userId,
      summary: 'done',
      model: 'test-model',
      inputTokens: 1,
      outputTokens: 2,
      durationMs: 3,
    })
    expect(getAiMessages(userId, workspace.session_id)).toHaveLength(2)

    deleteAiDataForUser(userId)

    expect(getAiWorkspace(userId)).toBeNull()
    expect(getAiMessages(userId, workspace.session_id)).toHaveLength(0)
  })
})

describe('ai_messages storage', () => {
  it('records one pending user/assistant pair per turn', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const turnId = randomUUID()

    expect(insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: 'build a site' })).toBe(
      true
    )

    const messages = getAiMessages(userId, workspace.session_id)
    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.role).sort()).toEqual(['assistant', 'user'])
    for (const message of messages) {
      expect(message).toMatchObject({ turn_id: turnId, session_id: workspace.session_id, status: 'pending' })
      expect(message.model).toBeNull()
      expect(message.input_tokens).toBeNull()
      expect(message.output_tokens).toBeNull()
      expect(message.duration_ms).toBeNull()
    }
    expect(messages.find((message) => message.role === 'user')?.content).toBe('build a site')
  })

  it('stores model, token, and duration values only on the assistant row', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const turnId = randomUUID()
    insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: 'hello' })

    expect(
      finalizeAiTurnSuccess({
        turnId,
        userId,
        summary: 'Created index.html',
        model: 'test-model',
        inputTokens: 2400,
        outputTokens: 1100,
        durationMs: 1800,
      })
    ).toBe(true)

    const messages = getAiMessages(userId, workspace.session_id)
    const assistant = messages.find((message) => message.role === 'assistant')!
    const user = messages.find((message) => message.role === 'user')!
    expect(assistant).toMatchObject({
      content: 'Created index.html',
      status: 'ok',
      model: 'test-model',
      input_tokens: 2400,
      output_tokens: 1100,
      duration_ms: 1800,
    })
    expect(user).toMatchObject({ status: 'ok', model: null, input_tokens: null, duration_ms: null })
  })

  it('finalizes failures with a safe summary and code, and excludes them from history', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const okTurn = randomUUID()
    const failedTurn = randomUUID()
    insertAiTurnPending({ turnId: okTurn, userId, sessionId: workspace.session_id, userContent: 'first' })
    finalizeAiTurnSuccess({ turnId: okTurn, userId, summary: 'first result', model: 'm', inputTokens: 1, outputTokens: 2, durationMs: 3 })
    insertAiTurnPending({ turnId: failedTurn, userId, sessionId: workspace.session_id, userContent: 'second' })
    finalizeAiTurnError({
      turnId: failedTurn,
      userId,
      summary: 'The model response could not be used.',
      errorCode: 'invalid_model_output',
      model: 'm',
      inputTokens: 4,
      outputTokens: null,
      durationMs: 5,
    })

    const assistant = getAiMessages(userId, workspace.session_id).find((message) => message.turn_id === failedTurn && message.role === 'assistant')!
    expect(assistant).toMatchObject({
      status: 'error',
      error_code: 'invalid_model_output',
      content: 'The model response could not be used.',
      input_tokens: 4,
      output_tokens: null,
    })

    const turns = getAiConversationTurns(userId, workspace.session_id)
    expect(turns).toEqual([{ turnId: okTurn, userContent: 'first', assistantContent: 'first result' }])
  })

  it('returns the newest twenty transcript rows of the current session in order', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const otherSession = randomUUID()
    for (let index = 0; index < 25; index += 1) {
      const turnId = randomUUID()
      insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: `message ${index}` })
      finalizeAiTurnSuccess({ turnId, userId, summary: `summary ${index}`, model: 'm', inputTokens: null, outputTokens: null, durationMs: null })
    }
    const otherTurn = randomUUID()
    insertAiTurnPending({ turnId: otherTurn, userId, sessionId: otherSession, userContent: 'other session' })

    const all = getAiMessages(userId, workspace.session_id, 100)
    const newest = getAiMessages(userId, workspace.session_id)

    expect(all).toHaveLength(50)
    expect(all.every((message) => message.session_id === workspace.session_id)).toBe(true)
    expect(newest).toHaveLength(20)
    expect(newest).toEqual(all.slice(-20))
  })

  it('refuses to write for an account that no longer exists', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    deleteAiDataForUser(userId)
    deleteUser(userId)

    expect(insertAiTurnPending({ turnId: randomUUID(), userId, sessionId: workspace.session_id, userContent: 'x' })).toBe(
      false
    )
    expect(getAiMessages(userId, workspace.session_id)).toHaveLength(0)
  })

  it('rolls the workspace switch back when the turn rows are gone', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!

    expect(() =>
      finalizeAiTurnSuccess({
        turnId: randomUUID(),
        userId,
        summary: 'never committed',
        model: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: null,
        workspace: {
          userId,
          expectedRevision: workspace.revision,
          expectedGeneration: workspace.current_generation,
          generation: randomUUID(),
          entryFile: 'index.html',
        },
      })
    ).toThrow()

    expect(getAiWorkspace(userId)).toMatchObject({ revision: 0, current_generation: null })
  })

  it('enforces the schema byte bound on stored content', () => {
    const userId = createUser()
    const overlong = truncateUtf8Bytes('a'.repeat(20000), 16384)
    expect(Buffer.byteLength(overlong, 'utf8')).toBe(16384)

    const database = new Database(getDbPath())
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO ai_messages (id, turn_id, user_id, session_id, role, content, status)
             VALUES (?, ?, ?, ?, 'user', ?, 'ok')`
          )
          .run(randomUUID(), randomUUID(), userId, randomUUID(), overlong + 'a')
      ).toThrow()
    } finally {
      database.close()
    }
  })

  it('keeps user rows free of usage fields and enforces one row per role and turn', () => {
    const userId = createUser()
    const workspace = getOrCreateAiWorkspace(userId)!
    const database = new Database(getDbPath())
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO ai_messages (id, turn_id, user_id, session_id, role, content, status, input_tokens)
             VALUES (?, ?, ?, ?, 'user', 'x', 'ok', 5)`
          )
          .run(randomUUID(), randomUUID(), userId, workspace.session_id)
      ).toThrow()
    } finally {
      database.close()
    }

    const turnId = randomUUID()
    expect(insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: 'x' })).toBe(true)
    expect(() => insertAiTurnPending({ turnId, userId, sessionId: workspace.session_id, userContent: 'again' })).toThrow()
  })

  it('rejects a partial attachment state on the workspace row', () => {
    const userId = createUser()
    getOrCreateAiWorkspace(userId)
    const database = new Database(getDbPath())
    try {
      expect(() =>
        database
          .prepare('UPDATE ai_workspaces SET attached_upload_id = ?, attached_slug = ? WHERE user_id = ?')
          .run(randomUUID(), null, userId)
      ).toThrow()
    } finally {
      database.close()
    }
  })
})

describe('truncateUtf8Bytes', () => {
  it('cuts on code-point boundaries within the byte budget', () => {
    expect(truncateUtf8Bytes('hello', 5)).toBe('hello')
    expect(truncateUtf8Bytes('hello', 3)).toBe('hel')
    expect(truncateUtf8Bytes('😀😀😀', 6)).toBe('😀')
    expect(Buffer.byteLength(truncateUtf8Bytes('😀😀😀', 6), 'utf8')).toBe(4)
    expect(truncateUtf8Bytes('€€', 4)).toBe('€')
    expect(truncateUtf8Bytes('abc', 0)).toBe('')
  })
})
