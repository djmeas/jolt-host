#!/usr/bin/env node
/**
 * Builds test/fixtures/dummy-site.zip from test/fixtures/dummy-site/
 * Run: node scripts/build-test-fixtures.mjs
 */
import archiver from 'archiver'
import { createWriteStream } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const siteDir = join(root, 'test', 'fixtures', 'dummy-site')
const outPath = join(root, 'test', 'fixtures', 'dummy-site.zip')

const output = createWriteStream(outPath)
const archive = archiver('zip', { zlib: { level: 9 } })

archive.pipe(output)
archive.directory(siteDir, false)
await archive.finalize()
output.on('close', () => console.log(`Created ${outPath} (${archive.pointer()} bytes)`))
