const BASE_URL = 'https://host.thunderjolt.app'

const routes = [
  { path: '/',         changefreq: 'weekly',  priority: '1.0' },
  { path: '/how-to',   changefreq: 'monthly', priority: '0.7' },
  { path: '/privacy',  changefreq: 'monthly', priority: '0.4' },
  { path: '/terms',    changefreq: 'monthly', priority: '0.4' },
]

export default defineEventHandler((event) => {
  const lastmod = new Date().toISOString().split('T')[0]

  const urls = routes
    .map(
      (r) => `  <url>
    <loc>${BASE_URL}${r.path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`,
    )
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`

  setHeader(event, 'Content-Type', 'application/xml')
  return xml
})
