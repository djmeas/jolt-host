import { cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../.output/public/', import.meta.url))
const destination = fileURLToPath(new URL('../.output/server/chunks/public/', import.meta.url))

cpSync(source, destination, { recursive: true })
