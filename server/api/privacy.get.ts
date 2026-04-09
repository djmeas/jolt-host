import { marked } from 'marked'

export default defineEventHandler(async () => {
  const storage = useStorage('assets:server')
  let md = await storage.getItem('docs:privacy-policy.md') as string || ''

  const supportEmail = process.env.SUPPORT_EMAIL

  if (supportEmail) {
    md = md.replace('{{SUPPORT_EMAIL}}', supportEmail)
  } else {
    // Remove the Contact section (heading, body, and trailing hr) entirely
    md = md.replace(/\n## Contact\n[\s\S]*?\n---\n/, '\n')
  }

  const html = marked.parse(md) as string
  return { html }
})
