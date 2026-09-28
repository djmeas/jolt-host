#!/usr/bin/env node
/**
 * Builds test/fixtures/dummy-site.zip and the update-flow ZIPs.
 * Run: node scripts/build-test-fixtures.mjs
 */
import archiver from 'archiver'
import { createWriteStream, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fixtures = join(root, 'test', 'fixtures')

function writeZip(outPath, addEntries) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    addEntries(archive)
    archive.finalize()
  })
}

const dummySite = join(fixtures, 'dummy-site')
await writeZip(join(fixtures, 'dummy-site.zip'), (archive) => {
  archive.directory(dummySite, false)
})
console.log('Created dummy-site.zip')

await writeZip(join(fixtures, 'replacement-site.zip'), (archive) => {
  archive.append(
    '<!DOCTYPE html><html><head><title>Replacement Site</title><link rel="stylesheet" href="new-style.css"></head><body><h1>Replacement Content</h1></body></html>',
    { name: 'index.html' }
  )
  archive.append('body { color: rebeccapurple; }', { name: 'new-style.css' })
})
console.log('Created replacement-site.zip')

await writeZip(join(fixtures, 'nested-entry-site.zip'), (archive) => {
  archive.append(
    '<!DOCTYPE html><html><head><title>Nested Entry Site</title></head><body><h1>Nested Entry</h1></body></html>',
    { name: 'pages/home.html' }
  )
})
console.log('Created nested-entry-site.zip')

const badDir = join(tmpdir(), `jolt-bad-zip-${Date.now()}`)
mkdirSync(badDir, { recursive: true })
writeFileSync(join(badDir, 'index.html'), '<h1>ok</h1>')
rmSync(badDir, { recursive: true, force: true })

const noHtmlDir = join(tmpdir(), `jolt-no-html-${Date.now()}`)
mkdirSync(noHtmlDir, { recursive: true })
writeFileSync(join(noHtmlDir, 'asset.txt'), 'no html here')
await writeZip(join(fixtures, 'no-html.zip'), (archive) => {
  archive.append('no html here', { name: 'asset.txt' })
})
rmSync(noHtmlDir, { recursive: true, force: true })
console.log('Created no-html.zip')

