import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')

describe('upload API fixtures', () => {
  it('dummy.html exists and is valid HTML', () => {
    const html = readFileSync(join(FIXTURES, 'dummy.html'), 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Dummy Test Site')
  })

  it('dummy-site.zip exists and contains index.html', async () => {
    const unzipper = await import('unzipper')
    const zipBuffer = readFileSync(join(FIXTURES, 'dummy-site.zip'))
    const directory = await unzipper.Open.buffer(zipBuffer)
    const htmlFiles = directory.files
      .filter((e) => e.type !== 'Directory' && e.path.toLowerCase().endsWith('.html'))
      .map((e) => e.path)
    expect(htmlFiles).toContain('index.html')
  })
})
