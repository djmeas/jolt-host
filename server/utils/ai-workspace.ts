/**
 * Private AI Builder workspaces.
 *
 * One logical workspace per verified account lives at
 * `<storage>/.workspaces/<user-id>/` and is never a served entry point. Atomic
 * updates are physical generations under `.generations/<uuid>/`; the publish
 * switch is the compare-and-switch of the `ai_workspaces` row, not a rename, so
 * a filesystem rename can never make a half-built generation live.
 *
 * This module owns path rules, quotas, generation materialization, verification,
 * and reads. It operates on *typed* operations; the untrusted JSON wire shape of
 * a model manifest is parsed and rejected by the chat pipeline before any
 * operation reaches these helpers. Staging/generation metadata is server-only
 * state: clients and models cannot write it, and nothing here is ever served.
 *
 * Callers must hold the per-user operation guard (`server/utils/ai-rate-limit`)
 * for the whole read-modify-commit sequence; helpers remove abandoned staging
 * state on the assumption that no other operation for the same user is running.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import archiver from 'archiver'
import { compareAndSwitchAiWorkspace, getAiWorkspace, getOrCreateAiWorkspace, getStorageDir } from '~/server/utils/db'
import { isBlockedAppPath } from '~/server/utils/site-host'

const WORKSPACES_ROOT = '.workspaces'
const STAGING_ROOT = '.staging'
const GENERATIONS_ROOT = '.generations'
const CONTENT_ROOT = 'content'
const METADATA_FILE = 'metadata.json'

export const DEFAULT_ENTRY_FILE = 'index.html'

/** Generated/editable text extensions. Case-insensitive; never binaries. */
export const AI_EDITABLE_EXTENSIONS = ['.html', '.css', '.js', '.md', '.txt', '.svg', '.json'] as const

/** Files an entry point may be. */
export const AI_ENTRY_EXTENSIONS = ['.html', '.md'] as const

/** Active editable-file-set ceilings. Boundaries are inclusive. */
export const AI_MAX_WORKSPACE_FILES = 50
export const AI_MAX_FILE_BYTES = 1024 * 1024
export const AI_MAX_WORKSPACE_BYTES = 5 * 1024 * 1024
export const AI_MAX_MANIFEST_OPERATIONS = 100

/** Byte bounds on path components (UTF-8 bytes, not characters). */
export const AI_MAX_PATH_BYTES = 240
export const AI_MAX_SEGMENT_BYTES = 100

/**
 * Retained opaque assets are bounded by the existing archive extraction ceiling,
 * not by the editable quota. They exist only for attached sites (phase 6).
 */
export const AI_MAX_OPAQUE_SOURCE_BYTES = 100 * 1024 * 1024

/** Segments that begin a generated path but are reserved by the application. */
const RESERVED_FIRST_SEGMENTS: Record<string, true> = { _jolt: true }

const SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const GENERATION_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SNAPSHOT_NAME_PATTERN = /^\.pre-edit-\d{10,}$/
const OWNER_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export type WorkspaceErrorCode =
  | 'invalid_path'
  | 'invalid_manifest'
  | 'file_not_found'
  | 'opaque_file'
  | 'workspace_limit_exceeded'
  | 'editable_workspace_too_large'
  | 'source_too_large'
  | 'no_edit_snapshot'
  | 'workspace_conflict'
  | 'workspace_storage_failed'
  | 'user_missing'

const STATUS_BY_CODE: Record<WorkspaceErrorCode, number> = {
  invalid_path: 400,
  invalid_manifest: 502,
  file_not_found: 404,
  opaque_file: 403,
  workspace_limit_exceeded: 413,
  editable_workspace_too_large: 413,
  source_too_large: 413,
  no_edit_snapshot: 409,
  workspace_conflict: 409,
  workspace_storage_failed: 500,
  user_missing: 401,
}

/** Carries the AI error code and suggested HTTP status for the endpoint layer. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode
  readonly statusCode: number

  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorkspaceError'
    this.code = code
    this.statusCode = STATUS_BY_CODE[code]
  }
}

export type WorkspaceFile = { path: string; bytes: number; editable: boolean }

export type WorkspaceFiles = {
  generation: string | null
  entryFile: string
  files: WorkspaceFile[]
  editableFiles: number
  editableBytes: number
  opaqueFiles: number
  opaqueBytes: number
}

export type WorkspaceOperation =
  | { op: 'add'; path: string; content: string }
  | { op: 'update'; path: string; content: string }
  | { op: 'delete'; path: string }

export type WorkspaceSeedFile = { path: string; data: Buffer }

type GenerationMetadata = {
  generation: string
  entry_file: string
  files: WorkspaceFile[]
  created_at: string
}

type LoadedGeneration = {
  generation: string
  entryFile: string
  files: WorkspaceFile[]
  contentRoot: string
}

type PlannedEntry = { path: string; bytes: number; editable: boolean } & (
  | { kind: 'inline'; data: Buffer }
  | { kind: 'copy'; from: string }
)

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

function invalidPath(message = 'Invalid workspace file path.'): WorkspaceError {
  return new WorkspaceError('invalid_path', message)
}

function invalidManifest(message: string): WorkspaceError {
  return new WorkspaceError('invalid_manifest', message)
}

/**
 * A path inside a provider-produced manifest is malformed model output, not a
 * client mistake, so lexical rejection is reported as `invalid_manifest`.
 */
function manifestPath(value: unknown): string {
  try {
    return validateWorkspacePath(value)
  } catch (error) {
    if (error instanceof WorkspaceError) throw invalidManifest('The model response contained an unsafe file path.')
    throw error
  }
}

function storageFailed(message: string, cause?: unknown): WorkspaceError {
  return new WorkspaceError('workspace_storage_failed', message, { cause })
}

/** Root directory of one account's workspace. Never served as site content. */
export function getWorkspaceDir(userId: string): string {
  if (typeof userId !== 'string' || !OWNER_ID_PATTERN.test(userId)) {
    throw invalidPath('Invalid workspace owner.')
  }
  return join(getStorageDir(), WORKSPACES_ROOT, userId)
}

/**
 * Validates a relative POSIX content path.
 *
 * Rejects, without rewriting, everything that could escape the content root or
 * name server state: absolute paths, Windows drive letters and separators,
 * `.`/`..` segments, empty segments, trailing slashes, dot-prefixed segments,
 * URL escapes, control characters, and paths longer than the byte budgets.
 */
export function validateWorkspacePath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) throw invalidPath()
  const path = input
  if (Buffer.byteLength(path, 'utf8') > AI_MAX_PATH_BYTES) throw invalidPath()
  if (path.startsWith('/') || path.endsWith('/')) throw invalidPath()
  if (path.includes('\\') || path.includes(':')) throw invalidPath()
  if (path.includes('%')) throw invalidPath()
  if (/[\u0000-\u001f\u007f]/.test(path)) throw invalidPath()

  const segments = path.split('/')
  const first = segments[0]!
  if (RESERVED_FIRST_SEGMENTS[first] === true || isBlockedAppPath(`/${path}`)) throw invalidPath()
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw invalidPath()
    if (segment.startsWith('.')) throw invalidPath()
    if (Buffer.byteLength(segment, 'utf8') > AI_MAX_SEGMENT_BYTES) throw invalidPath()
    if (!SEGMENT_PATTERN.test(segment)) throw invalidPath()
  }
  return path
}

/** The allowed editable extension for a path, lower-cased, or null. */
export function editableExtension(path: string): string | null {
  const lower = path.toLowerCase()
  const index = lower.lastIndexOf('.')
  if (index <= lower.lastIndexOf('/')) return null
  const extension = lower.slice(index)
  return (AI_EDITABLE_EXTENSIONS as readonly string[]).includes(extension) ? extension : null
}

export function isEditableWorkspacePath(path: string): boolean {
  return editableExtension(path) !== null
}

/** True when a path is a valid decodable text file with an editable extension. */
function isEditableContent(path: string, data: Buffer): boolean {
  if (!isEditableWorkspacePath(path) || data.includes(0)) return false
  try {
    utf8Strict.decode(data)
    return true
  } catch {
    return false
  }
}

function isInsideDirectory(baseDir: string, target: string): boolean {
  const rel = relative(baseDir, target)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  return true
}

function toFilesystemPath(contentRoot: string, relativePath: string): string {
  const full = resolve(contentRoot, ...relativePath.split('/'))
  if (!isInsideDirectory(contentRoot, full)) throw invalidPath()
  return full
}

function summarize(generation: string | null, entryFile: string, files: WorkspaceFile[]): WorkspaceFiles {
  let editableFiles = 0
  let editableBytes = 0
  let opaqueFiles = 0
  let opaqueBytes = 0
  for (const file of files) {
    if (file.editable) {
      editableFiles += 1
      editableBytes += file.bytes
    } else {
      opaqueFiles += 1
      opaqueBytes += file.bytes
    }
  }
  return { generation, entryFile, files, editableFiles, editableBytes, opaqueFiles, opaqueBytes }
}

/**
 * Rejects duplicate, case-folded, and file/directory-prefix collisions.
 * macOS development and Linux production must agree on which paths collide.
 */
function assertDistinctPaths(paths: string[]): void {
  const exact = new Set<string>()
  const folded = new Set<string>()
  for (const path of paths) {
    if (exact.has(path)) throw invalidManifest(`Duplicate file path: ${path}`)
    exact.add(path)
    const key = path.toLowerCase()
    if (folded.has(key)) throw invalidManifest('Two files differ only by letter case.')
    folded.add(key)
  }
  const sorted = [...paths].sort()
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startsWith(`${sorted[index - 1]!}/`)) {
      throw invalidManifest('A file path is also used as a directory.')
    }
  }
}

function assertSafeDirectory(path: string, message: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch (err) {
    throw storageFailed(message, err)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw storageFailed(message)
}

/** Every stored file, with symbolic links and non-regular entries rejected. */
function walkContentFiles(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = lstatSync(full)
      const rel = prefix ? `${prefix}/${name}` : name
      if (stat.isSymbolicLink()) throw storageFailed('Unexpected symbolic link in workspace storage.')
      if (stat.isDirectory()) {
        visit(full, rel)
        continue
      }
      if (!stat.isFile()) throw storageFailed('Unexpected file type in workspace storage.')
      found.push(rel)
    }
  }
  visit(root, '')
  return found
}

/**
 * Re-reads a content tree from disk and proves it matches the planned file set
 * exactly: same paths, same byte counts, regular files only, no extras.
 */
function verifyContentTree(contentRoot: string, expected: { path: string; bytes: number }[]): void {
  const stored = walkContentFiles(contentRoot)
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.bytes]))
  if (stored.length !== expected.length) throw storageFailed('Workspace content does not match its metadata.')
  for (const path of stored) {
    try {
      validateWorkspacePath(path)
    } catch {
      throw storageFailed('Workspace content contains an unexpected path.')
    }
    const bytes = expectedByPath.get(path)
    if (bytes === undefined) throw storageFailed('Workspace content does not match its metadata.')
    const stat = lstatSync(join(contentRoot, ...path.split('/')))
    if (stat.size !== bytes) throw storageFailed('Workspace content size changed during staging.')
  }
}

function parseMetadata(raw: string, generation: string): { entryFile: string; files: WorkspaceFile[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw storageFailed('Workspace metadata is unreadable.', err)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw storageFailed('Workspace metadata is unreadable.')
  }
  const metadata = parsed as Partial<GenerationMetadata>
  if (metadata.generation !== generation || typeof metadata.entry_file !== 'string' || !Array.isArray(metadata.files)) {
    throw storageFailed('Workspace metadata is unreadable.')
  }
  const files: WorkspaceFile[] = []
  for (const entry of metadata.files) {
    if (typeof entry !== 'object' || entry === null) throw storageFailed('Workspace metadata is unreadable.')
    const file = entry as Partial<WorkspaceFile>
    if (typeof file.path !== 'string' || typeof file.bytes !== 'number' || typeof file.editable !== 'boolean') {
      throw storageFailed('Workspace metadata is unreadable.')
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw storageFailed('Workspace metadata is unreadable.')
    try {
      validateWorkspacePath(file.path)
    } catch {
      throw storageFailed('Workspace metadata contains an unexpected path.')
    }
    if (file.editable && !isEditableWorkspacePath(file.path)) {
      throw storageFailed('Workspace metadata misclassifies a file.')
    }
    files.push({ path: file.path, bytes: file.bytes, editable: file.editable })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  assertDistinctPaths(files.map((file) => file.path))
  const entryFile = metadata.entry_file
  try {
    validateWorkspacePath(entryFile)
  } catch {
    throw storageFailed('Workspace metadata has an invalid entry file.')
  }
  const entry = files.find((file) => file.path === entryFile)
  if (!entry || !entry.editable || !(AI_ENTRY_EXTENSIONS as readonly string[]).includes(editableExtension(entryFile) ?? '')) {
    throw storageFailed('Workspace metadata has an invalid entry file.')
  }
  return { entryFile, files }
}

/**
 * Loads one server-written content directory (a committed generation or a
 * pre-edit snapshot), verifying containment, metadata, and exact bytes.
 */
function loadContentTree(workspaceDir: string, dir: string, name: string): LoadedGeneration {
  assertSafeDirectory(dir, 'Workspace storage is unavailable.')
  const contentRoot = join(dir, CONTENT_ROOT)
  assertSafeDirectory(contentRoot, 'Workspace storage is unavailable.')

  const realWorkspace = realpathSync(workspaceDir)
  if (!isInsideDirectory(realWorkspace, realpathSync(contentRoot))) {
    throw storageFailed('Workspace generation escapes its storage root.')
  }

  const metadataPath = join(dir, METADATA_FILE)
  let metadataStat
  try {
    metadataStat = lstatSync(metadataPath)
  } catch (err) {
    throw storageFailed('Workspace metadata is unavailable.', err)
  }
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) throw storageFailed('Workspace metadata is unavailable.')
  const { entryFile, files } = parseMetadata(readFileSync(metadataPath, 'utf8'), name)
  verifyContentTree(contentRoot, files)
  return { generation: name, entryFile, files, contentRoot }
}

/** Loads one committed generation, verifying containment, metadata, and bytes. */
function loadGeneration(userId: string, generation: string): LoadedGeneration {
  if (!GENERATION_NAME_PATTERN.test(generation)) throw storageFailed('Unknown workspace generation.')
  const workspaceDir = getWorkspaceDir(userId)
  assertSafeDirectory(workspaceDir, 'Workspace storage is unavailable.')
  const generationsDir = join(workspaceDir, GENERATIONS_ROOT)
  assertSafeDirectory(generationsDir, 'Workspace storage is unavailable.')
  return loadContentTree(workspaceDir, join(generationsDir, generation), generation)
}

/**
 * Loads the active session's pre-edit snapshot. Snapshots are private local
 * state: they are never published, never served, and never carry settings.
 */
export function loadPreEditSnapshot(userId: string, snapshotDir: string): LoadedGeneration {
  if (!SNAPSHOT_NAME_PATTERN.test(snapshotDir)) throw storageFailed('Unknown workspace snapshot.')
  const workspaceDir = getWorkspaceDir(userId)
  assertSafeDirectory(workspaceDir, 'Workspace storage is unavailable.')
  return loadContentTree(workspaceDir, join(workspaceDir, snapshotDir), snapshotDir)
}

/** Public description of the active workspace; an empty workspace has no files. */
export function describeWorkspace(userId: string, generation: string | null): WorkspaceFiles {
  if (generation === null) return summarize(null, DEFAULT_ENTRY_FILE, [])
  const loaded = loadGeneration(userId, generation)
  return summarize(loaded.generation, loaded.entryFile, loaded.files)
}

/** Reads one editable text file. Opaque bytes are never exposed through here. */
export function readWorkspaceFile(
  userId: string,
  generation: string | null,
  filePath: string
): { path: string; content: string; bytes: number } {
  const path = validateWorkspacePath(filePath)
  if (generation === null) throw new WorkspaceError('file_not_found', 'No such workspace file.')
  const loaded = loadGeneration(userId, generation)
  const file = loaded.files.find((entry) => entry.path === path)
  if (!file) throw new WorkspaceError('file_not_found', 'No such workspace file.')
  if (!file.editable) throw new WorkspaceError('opaque_file', 'This file is not editable text.')
  const full = toFilesystemPath(loaded.contentRoot, path)
  const stat = lstatSync(full)
  if (stat.isSymbolicLink() || !stat.isFile()) throw storageFailed('Workspace content is unavailable.')
  const content = readFileSync(full).toString('utf8')
  return { path, content, bytes: Buffer.byteLength(content, 'utf8') }
}

/**
 * Reads the full text of every editable file in a committed generation in one
 * verified pass, sorted by path. This is the model's view of current workspace
 * state; opaque assets are excluded, so their bytes never enter a prompt.
 */
export function readEditableWorkspaceFiles(
  userId: string,
  generation: string | null
): { path: string; content: string }[] {
  if (generation === null) return []
  const loaded = loadGeneration(userId, generation)
  const files: { path: string; content: string }[] = []
  for (const file of loaded.files) {
    if (!file.editable) continue
    const full = toFilesystemPath(loaded.contentRoot, file.path)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) throw storageFailed('Workspace content is unavailable.')
    files.push({ path: file.path, content: readFileSync(full).toString('utf8') })
  }
  return files
}

/**
 * Packages the committed files of one generation into an in-memory ZIP for
 * publication. Server metadata, generation directories, snapshots, and chat
 * text are never included. Attached workspaces carry their opaque assets
 * byte-for-byte into the archive; new-mode workspaces never contain any, so a
 * preview archive still contains only generated text.
 */
export async function buildWorkspaceZip(userId: string, generation: string | null): Promise<Buffer> {
  if (generation === null) throw new WorkspaceError('file_not_found', 'The workspace is empty.')
  const loaded = loadGeneration(userId, generation)

  const entries: { path: string; data: Buffer }[] = []
  for (const file of [...loaded.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const full = toFilesystemPath(loaded.contentRoot, file.path)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile()) throw storageFailed('Workspace content is unavailable.')
    entries.push({ path: file.path, data: readFileSync(full) })
  }
  if (entries.length === 0) throw new WorkspaceError('file_not_found', 'The workspace is empty.')

  const archive = archiver('zip', { zlib: { level: 9 } })
  const chunks: Buffer[] = []
  const finished = new Promise<Buffer>((resolveArchive, rejectArchive) => {
    archive.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    archive.on('warning', () => {})
    archive.on('error', (error: Error) =>
      rejectArchive(storageFailed('The workspace archive could not be built.', error))
    )
    archive.on('end', () => resolveArchive(Buffer.concat(chunks)))
  })
  for (const entry of entries) {
    archive.append(entry.data, { name: entry.path })
  }
  archive.finalize().catch(() => {
    // Failures surface through the `error` event handled above.
  })
  return finished
}

function assertEditableQuota(
  files: WorkspaceFile[],
  code: WorkspaceErrorCode = 'workspace_limit_exceeded'
): void {
  const editable = files.filter((file) => file.editable)
  if (editable.length > AI_MAX_WORKSPACE_FILES) {
    throw new WorkspaceError(
      code,
      `The workspace allows at most ${AI_MAX_WORKSPACE_FILES} editable files.`
    )
  }
  let total = 0
  for (const file of editable) {
    if (file.bytes > AI_MAX_FILE_BYTES) {
      throw new WorkspaceError(code, `Each file must be at most ${AI_MAX_FILE_BYTES} bytes.`)
    }
    total += file.bytes
  }
  if (total > AI_MAX_WORKSPACE_BYTES) {
    throw new WorkspaceError(
      code,
      `The editable workspace allows at most ${AI_MAX_WORKSPACE_BYTES} bytes in total.`
    )
  }
}

/** Asserts the union of all stored paths (editable and opaque) is collision-free. */
function assertFinalPathSet(editable: { path: string }[], opaque: { path: string }[]): void {
  assertDistinctPaths([...editable.map((file) => file.path), ...opaque.map((file) => file.path)])
}

/**
 * Turns operations into the complete next file set: retained editable files are
 * copied, adds/updates write their whole content, deletes are omitted, and
 * retained opaque assets are carried byte-for-byte.
 */
function planOperations(base: LoadedGeneration | null, operations: WorkspaceOperation[]): PlannedEntry[] {
  if (operations.length === 0) throw invalidManifest('A turn must contain at least one file operation.')
  if (operations.length > AI_MAX_MANIFEST_OPERATIONS) {
    throw invalidManifest(`A turn may contain at most ${AI_MAX_MANIFEST_OPERATIONS} file operations.`)
  }

  const baseEditable = new Map<string, WorkspaceFile>()
  const baseOpaque = new Map<string, WorkspaceFile>()
  for (const file of base?.files ?? []) {
    if (file.editable) baseEditable.set(file.path, file)
    else baseOpaque.set(file.path, file)
  }

  const writes = new Map<string, Buffer>()
  const deletes = new Set<string>()
  const operationPaths = new Set<string>()
  for (const operation of operations) {
    // Operations arrive from a parsed model manifest; re-check the shape here so
    // a caller that skipped its own parse cannot smuggle anything through.
    const raw: unknown = operation
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidManifest('Invalid file operation.')
    if (!('op' in raw)) throw invalidManifest('Invalid file operation.')
    if (!('path' in raw)) throw invalidManifest('Invalid file operation.')
    const op = raw.op
    if (op !== 'add' && op !== 'update' && op !== 'delete') throw invalidManifest('Unknown file operation.')
    const path = manifestPath(raw.path)
    const foldedPath = path.toLowerCase()
    if (operationPaths.has(foldedPath)) throw invalidManifest('The same file was operated on twice.')
    operationPaths.add(foldedPath)
    if (op === 'delete') {
      if ('content' in raw) throw invalidManifest('A delete operation must not carry content.')
      if (!baseEditable.has(path)) throw invalidManifest(`Cannot delete a file that does not exist: ${path}`)
      deletes.add(path)
      continue
    }
    if (!isEditableWorkspacePath(path)) throw invalidManifest(`Unsupported file type: ${path}`)
    const content = 'content' in raw ? raw.content : undefined
    if (typeof content !== 'string') throw invalidManifest(`Missing content for ${path}`)
    const exists = baseEditable.has(path)
    if (op === 'add' && exists) throw invalidManifest(`Cannot add a file that already exists: ${path}`)
    if (op === 'update' && !exists) throw invalidManifest(`Cannot update a file that does not exist: ${path}`)
    if (baseOpaque.has(path)) throw invalidManifest(`Cannot modify an existing asset: ${path}`)
    writes.set(path, Buffer.from(content, 'utf8'))
  }

  const plannedPaths = new Set(writes.keys())
  for (const path of baseEditable.keys()) {
    if (!deletes.has(path)) plannedPaths.add(path)
  }
  // An operation must never collide with an untouched asset, by name or by case.
  assertFinalPathSet([...plannedPaths].map((path) => ({ path })), [...baseOpaque.keys()].map((path) => ({ path })))

  const entryFile = base?.entryFile ?? DEFAULT_ENTRY_FILE
  if (!plannedPaths.has(entryFile)) throw invalidManifest('The active entry file must still exist after the turn.')
  if (!(AI_ENTRY_EXTENSIONS as readonly string[]).includes(editableExtension(entryFile) ?? '')) {
    throw invalidManifest('The active entry file must be HTML or Markdown.')
  }

  const planned: PlannedEntry[] = []
  for (const path of plannedPaths) {
    const data = writes.get(path)
    if (data) {
      planned.push({ path, bytes: data.length, editable: true, kind: 'inline', data })
      continue
    }
    const retained = baseEditable.get(path)!
    planned.push({
      path,
      bytes: retained.bytes,
      editable: true,
      kind: 'copy',
      from: toFilesystemPath(base!.contentRoot, path),
    })
  }
  for (const [path, file] of baseOpaque) {
    planned.push({
      path,
      bytes: file.bytes,
      editable: false,
      kind: 'copy',
      from: toFilesystemPath(base!.contentRoot, path),
    })
  }
  planned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const described = planned.map(({ path, bytes, editable }) => ({ path, bytes, editable }))
  assertEditableQuota(described)
  return planned
}

/**
 * Writes a complete content tree plus its server metadata into a fresh
 * directory: content writes, verification, then the metadata file. The caller
 * owns the directory's lifecycle; nothing here is live until the DB pointer
 * (generation) or the workspace row (snapshot) references it.
 */
function writeContentTree(dir: string, name: string, entryFile: string, planned: PlannedEntry[]): void {
  const contentRoot = join(dir, CONTENT_ROOT)
  mkdirSync(contentRoot, { recursive: true })
  for (const entry of planned) {
    const target = toFilesystemPath(contentRoot, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    if (entry.kind === 'inline') writeFileSync(target, entry.data)
    else copyFileSync(entry.from, target)
  }

  const described = planned.map(({ path, bytes, editable }) => ({ path, bytes, editable }))
  verifyContentTree(contentRoot, described)

  const metadata: GenerationMetadata = {
    generation: name,
    entry_file: entryFile,
    files: described,
    created_at: new Date().toISOString(),
  }
  writeFileSync(join(dir, METADATA_FILE), JSON.stringify(metadata))
}

/**
 * Materializes the planned file set: fresh staging directory, content writes,
 * verification, server metadata, then one rename into `.generations/<uuid>`.
 * The directory is not live until the DB pointer switches. On any failure only
 * the fresh directory is removed.
 */
function materializeGeneration(userId: string, entryFile: string, planned: PlannedEntry[]): WorkspaceFiles {
  const workspaceDir = getWorkspaceDir(userId)
  const generation = randomUUID()
  const stagingDir = join(workspaceDir, STAGING_ROOT, generation)
  const generationDir = join(workspaceDir, GENERATIONS_ROOT, generation)

  try {
    writeContentTree(stagingDir, generation, entryFile, planned)
    mkdirSync(dirname(generationDir), { recursive: true })
    renameSync(stagingDir, generationDir)
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(generationDir, { recursive: true, force: true })
    if (err instanceof WorkspaceError) throw err
    throw storageFailed('The workspace could not be written.', err)
  }

  return summarize(generation, entryFile, planned.map(({ path, bytes, editable }) => ({ path, bytes, editable })))
}

/**
 * Builds the complete next generation for a patch turn. Validates the whole
 * proposed final file set (paths, collisions, quotas, entry file) before any
 * state is written, and leaves the active generation untouched.
 */
export function stageWorkspaceGeneration(
  userId: string,
  base: WorkspaceFiles,
  operations: WorkspaceOperation[]
): WorkspaceFiles {
  const loaded = base.generation === null ? null : loadGeneration(userId, base.generation)
  const planned = planOperations(loaded, operations)
  return materializeGeneration(userId, loaded?.entryFile ?? DEFAULT_ENTRY_FILE, planned)
}

/** Source-byte ceiling shared by every seeding path (the extraction ceiling). */
function assertSourceCeiling(bytes: number): void {
  if (bytes > AI_MAX_OPAQUE_SOURCE_BYTES) {
    throw new WorkspaceError(
      'source_too_large',
      `The source site is larger than the ${AI_MAX_OPAQUE_SOURCE_BYTES} byte attachment ceiling.`
    )
  }
}

/**
 * Validates and classifies seed entries without touching storage: allowed text
 * extensions that decode as UTF-8 without NUL are editable, everything else is
 * opaque. Errors carry the caller-chosen editable-limit code so the attach
 * route can report `editable_workspace_too_large` while ordinary seeding keeps
 * the generic workspace limit.
 */
function planSeedEntries(
  entries: WorkspaceSeedFile[],
  editableLimitCode: WorkspaceErrorCode
): PlannedEntry[] {
  if (entries.length === 0) throw invalidManifest('A workspace needs at least one file.')
  const planned: PlannedEntry[] = []
  let sourceBytes = 0
  for (const entry of entries) {
    const path = validateWorkspacePath(entry.path)
    if (!Buffer.isBuffer(entry.data)) throw invalidManifest('Invalid workspace file content.')
    sourceBytes += entry.data.length
    const editable = isEditableContent(path, entry.data)
    planned.push({ path, bytes: entry.data.length, editable, kind: 'inline', data: entry.data })
  }
  assertFinalPathSet(
    planned.filter((entry) => entry.editable),
    planned.filter((entry) => !entry.editable)
  )
  assertSourceCeiling(sourceBytes)
  assertEditableQuota(planned.map(({ path, bytes, editable }) => ({ path, bytes, editable })), editableLimitCode)
  return planned
}

/** The seeded entry file must be an editable HTML or Markdown file. */
function assertSeedEntryFile(planned: PlannedEntry[], entryFile: string): void {
  const entry = planned.find((candidate) => candidate.path === entryFile)
  if (!entry || !entry.editable) throw invalidManifest('The entry file must be an editable HTML or Markdown file.')
  if (!(AI_ENTRY_EXTENSIONS as readonly string[]).includes(editableExtension(entryFile) ?? '')) {
    throw invalidManifest('The entry file must be HTML or Markdown.')
  }
}

/**
 * Seeds a generation from raw bytes. Files that are allowed text extensions and
 * decode as UTF-8 without NUL are editable; everything else is opaque and
 * carried through later turns byte-for-byte.
 */
export function writeWorkspaceGeneration(
  userId: string,
  entries: WorkspaceSeedFile[],
  entryFile: string
): WorkspaceFiles {
  const planned = planSeedEntries(entries, 'workspace_limit_exceeded')
  assertSeedEntryFile(planned, entryFile)
  return materializeGeneration(userId, entryFile, planned)
}

/**
 * Validates a prospective attachment without writing anything, so an
 * over-limit or unusable source is refused before a workspace row or private
 * file is created.
 */
export function assertAttachableSource(entries: WorkspaceSeedFile[], entryFile: string): void {
  const planned = planSeedEntries(entries, 'editable_workspace_too_large')
  assertSeedEntryFile(planned, entryFile)
}

/**
 * Seeds a generation from an attached site's live served root. Classifies the
 * same way as `writeWorkspaceGeneration` but reports attachment-specific limit
 * codes so the UI can explain which editable count/byte ceiling was exceeded.
 */
export function attachWorkspaceGeneration(
  userId: string,
  entries: WorkspaceSeedFile[],
  entryFile: string
): WorkspaceFiles {
  const planned = planSeedEntries(entries, 'editable_workspace_too_large')
  assertSeedEntryFile(planned, entryFile)
  return materializeGeneration(userId, entryFile, planned)
}

/** A collision-free `.pre-edit-<timestamp>` name inside one workspace root. */
function nextSnapshotName(workspaceDir: string): string {
  let timestamp = Date.now()
  while (existsSync(join(workspaceDir, `.pre-edit-${timestamp}`))) timestamp += 1
  return `.pre-edit-${timestamp}`
}

/**
 * Writes the one active pre-edit snapshot for an attach session. The snapshot is
 * the attached site's bytes at attach time: never published, never served, and
 * replaced only after a new attachment commits.
 */
export function writePreEditSnapshot(
  userId: string,
  entries: WorkspaceSeedFile[],
  entryFile: string
): string {
  const planned = planSeedEntries(entries, 'editable_workspace_too_large')
  assertSeedEntryFile(planned, entryFile)
  const workspaceDir = getWorkspaceDir(userId)
  const snapshotDir = nextSnapshotName(workspaceDir)
  writeContentTree(join(workspaceDir, snapshotDir), snapshotDir, entryFile, planned)
  return snapshotDir
}

/** Removes a snapshot that was written but never committed. */
export function discardSnapshot(userId: string, snapshotDir: string | null): void {
  if (snapshotDir === null || !SNAPSHOT_NAME_PATTERN.test(snapshotDir)) return
  try {
    rmSync(join(getWorkspaceDir(userId), snapshotDir), { recursive: true, force: true })
  } catch (err) {
    throw storageFailed('The previous-version snapshot could not be removed.', err)
  }
}

/**
 * Stages a new generation from the active session's pre-edit snapshot. This is a
 * local restore of the attached site's original bytes; it does not publish and
 * does not carry over any site settings.
 */
export function stageSnapshotRestore(userId: string, snapshotDir: string): WorkspaceFiles {
  const snapshot = loadPreEditSnapshot(userId, snapshotDir)
  const planned: PlannedEntry[] = snapshot.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    editable: file.editable,
    kind: 'copy',
    from: toFilesystemPath(snapshot.contentRoot, file.path),
  }))
  return materializeGeneration(userId, snapshot.entryFile, planned)
}

const SERVED_ROOT_FORBIDDEN_SEGMENTS: Record<string, true> = {
  '.staging': true,
  '.trash': true,
  '.workspaces': true,
}

/** A live upload's served files and its active entry file. */
export type ServedSiteSource = { entryFile: string; entries: WorkspaceSeedFile[] }

/**
 * Resolves an upload's live served root (`dirname(entry_point)`) and reads every
 * regular file beneath it, relative to that root. Symlinks, non-regular files,
 * unsafe names, and paths outside `<storage>` are attachment errors rather than
 * silently dropped files. The root is realpath-contained inside storage and can
 * never be a staging/trash/workspace directory.
 */
export function readServedSiteFiles(entryPoint: string): ServedSiteSource {
  if (typeof entryPoint !== 'string' || entryPoint.length === 0 || entryPoint.includes('\\')) {
    throw invalidPath('The site entry point is not a usable path.')
  }
  const segments = entryPoint.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw invalidPath('The site entry point is not a usable path.')
  }
  if (SERVED_ROOT_FORBIDDEN_SEGMENTS[segments[0]!] === true) {
    throw invalidPath('The site entry point is not a served location.')
  }
  const entryFile = segments[segments.length - 1]!
  if (segments.length < 2 || !(AI_ENTRY_EXTENSIONS as readonly string[]).includes(editableExtension(entryFile) ?? '')) {
    throw invalidPath('The site entry point is not a usable served file.')
  }

  const storageDir = getStorageDir()
  const root = dirname(join(storageDir, ...segments))
  if (!isInsideDirectory(storageDir, root) || root === storageDir) {
    throw invalidPath('The site entry point is outside the served storage root.')
  }
  assertSafeDirectory(root, 'The site content directory is unavailable.')

  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch (err) {
    throw storageFailed('The site content directory is unavailable.', err)
  }
  if (!isInsideDirectory(realpathSync(storageDir), realRoot)) {
    throw invalidPath('The site content directory is outside the served storage root.')
  }

  const entries: WorkspaceSeedFile[] = []
  let totalBytes = 0
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = lstatSync(full)
      const relative = prefix ? `${prefix}/${name}` : name
      if (stat.isSymbolicLink()) throw invalidPath('The site content contains a symbolic link.')
      if (stat.isDirectory()) {
        visit(full, relative)
        continue
      }
      if (!stat.isFile()) throw invalidPath('The site content contains an unsupported file type.')
      validateWorkspacePath(relative)
      totalBytes += stat.size
      assertSourceCeiling(totalBytes)
      entries.push({ path: relative, data: readFileSync(full) })
    }
  }
  visit(realRoot, '')

  const entry = entries.find((candidate) => candidate.path === entryFile)
  if (!entry || !isEditableContent(entryFile, entry.data)) {
    throw invalidPath('The site entry point is not an editable served file.')
  }
  return { entryFile, entries }
}

/** Removes a generation that was prepared but never published. */
export function discardPreparedGeneration(userId: string, generation: string | null): void {
  if (generation === null || !GENERATION_NAME_PATTERN.test(generation)) return
  const target = join(getWorkspaceDir(userId), GENERATIONS_ROOT, generation)
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (err) {
    throw storageFailed('The prepared workspace generation could not be removed.', err)
  }
}

/**
 * Publishes a prepared generation. On a lost compare-and-switch the fresh
 * generation is removed and the previous pointer/files stay active.
 */
export function commitPreparedGeneration(
  userId: string,
  prepared: { generation: string | null; entryFile: string },
  expectedRevision: number,
  expectedGeneration: string | null
): boolean {
  if (prepared.generation === null) return false
  const switched = compareAndSwitchAiWorkspace({
    userId,
    expectedRevision,
    expectedGeneration,
    generation: prepared.generation,
    entryFile: prepared.entryFile,
  })
  if (!switched) {
    discardPreparedGeneration(userId, prepared.generation)
    return false
  }
  const row = getAiWorkspace(userId)
  pruneWorkspaceGenerations(userId, prepared.generation, row?.snapshot_dir ?? null)
  return true
}

/**
 * Stages then commits one set of operations. Throws `workspace_conflict` when
 * the caller's revision/generation no longer match, leaving committed state
 * untouched.
 */
export function applyWorkspaceGeneration(
  userId: string,
  input: { expectedRevision: number; expectedGeneration: string | null; operations: WorkspaceOperation[] }
): WorkspaceFiles {
  const current = getOrCreateAiWorkspace(userId)
  if (!current) throw new WorkspaceError('user_missing', 'The account no longer exists.')
  if (current.revision !== input.expectedRevision || current.current_generation !== input.expectedGeneration) {
    throw new WorkspaceError('workspace_conflict', 'The workspace changed since it was loaded.')
  }
  const base = describeWorkspace(userId, current.current_generation)
  const prepared = stageWorkspaceGeneration(userId, base, input.operations)
  if (!commitPreparedGeneration(userId, prepared, current.revision, current.current_generation)) {
    throw new WorkspaceError('workspace_conflict', 'The workspace changed since it was loaded.')
  }
  return describeWorkspace(userId, prepared.generation)
}

/**
 * Removes staging, unreferenced generations, and inactive snapshots. Only safe
 * while holding the user operation guard; the active generation and the active
 * snapshot are never removed, and no time-based retention is applied.
 */
export function pruneWorkspaceGenerations(
  userId: string,
  activeGeneration: string | null,
  activeSnapshotDir: string | null
): void {
  const workspaceDir = getWorkspaceDir(userId)
  if (!existsSync(workspaceDir)) return
  try {
    rmSync(join(workspaceDir, STAGING_ROOT), { recursive: true, force: true })
    const generationsDir = join(workspaceDir, GENERATIONS_ROOT)
    if (existsSync(generationsDir)) {
      for (const name of readdirSync(generationsDir)) {
        if (name === activeGeneration) continue
        rmSync(join(generationsDir, name), { recursive: true, force: true })
      }
    }
    for (const name of readdirSync(workspaceDir)) {
      if (!SNAPSHOT_NAME_PATTERN.test(name) || name === activeSnapshotDir) continue
      rmSync(join(workspaceDir, name), { recursive: true, force: true })
    }
  } catch (err) {
    throw storageFailed('The workspace could not be cleaned up.', err)
  }
}

/**
 * Removes the whole workspace, including snapshots. A failure is surfaced: a
 * partial removal must never be reported as a completed deletion.
 */
export function deleteWorkspaceForUser(userId: string): void {
  const workspaceDir = getWorkspaceDir(userId)
  if (!existsSync(workspaceDir)) return
  try {
    rmSync(workspaceDir, { recursive: true, force: true })
  } catch (err) {
    throw storageFailed('The workspace could not be removed.', err)
  }
  if (existsSync(workspaceDir)) throw storageFailed('The workspace could not be removed.')
}
