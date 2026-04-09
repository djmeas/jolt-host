import { marked } from 'marked'

export default defineEventHandler(async () => {
  const storage = useStorage('assets:server')
  const md = await storage.getItem('docs:terms-and-conditions.md') as string || ''
  const html = marked.parse(md) as string
  return { html }
})
