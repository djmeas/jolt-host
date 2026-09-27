#!/usr/bin/env node
/**
 * Builds the malicious `escape-site.zip` fixture directly. Node's archiver
 * normalises `../` entry names, so the archive is assembled by hand.
 * Run: node scripts/build-escape-fixture.mjs
 */
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '..', 'test', 'fixtures', 'escape-site.zip')

const indexHtml = Buffer.from('<!DOCTYPE html><html><body><h1>ok</h1></body></html>')
const escapeTarget = Buffer.from('escape')

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function makeEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  return { local: Buffer.concat([local, nameBuf, data]), nameBuf, crc, size: data.length }
}

const entries = [makeEntry('index.html', indexHtml), makeEntry('../../escape.txt', escapeTarget)]

const parts = []
const centralParts = []
let offset = 0
for (const e of entries) {
  parts.push(e.local)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt32LE(e.crc, 16)
  central.writeUInt32LE(e.size, 20)
  central.writeUInt32LE(e.size, 24)
  central.writeUInt16LE(e.nameBuf.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  centralParts.push(Buffer.concat([central, e.nameBuf]))
  offset += e.local.length
}

const centralDir = Buffer.concat(centralParts)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralDir.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

writeFileSync(outPath, Buffer.concat([...parts, centralDir, end]))
console.log(`Created ${outPath}`)
