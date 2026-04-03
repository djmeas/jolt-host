const STORAGE_KEY = 'joltHost_mySites'

export interface MySite {
  siteUrl: string
  title?: string
  createdAt: string
  expiresAt: string | null
}

function readSites(): MySite[] {
  if (!import.meta.client) return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as MySite[]
  } catch {
    return []
  }
}

function writeSites(sites: MySite[]): void {
  if (!import.meta.client) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites))
  } catch {}
}

export function useMySites() {
  const sites = useState<MySite[]>('mySites', () => [])

  function load() {
    sites.value = readSites()
  }

  function addSite(site: MySite) {
    const current = readSites()
    // Avoid duplicates by siteUrl
    if (!current.find((s) => s.siteUrl === site.siteUrl)) {
      current.unshift(site)
      writeSites(current)
    }
    sites.value = current
  }

  function clearSites() {
    if (!import.meta.client) return
    localStorage.removeItem(STORAGE_KEY)
    sites.value = []
  }

  return { sites, load, addSite, clearSites }
}
