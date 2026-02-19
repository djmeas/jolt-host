const adjectives = [
  'quick', 'brave', 'calm', 'daring', 'eager', 'fancy', 'gentle', 'happy',
  'icy', 'jolly', 'kind', 'lucky', 'merry', 'nice', 'odd', 'proud',
  'quiet', 'rapid', 'swift', 'tidy', 'ultra', 'vivid', 'warm', 'zesty',
]
const nouns = [
  'apple', 'bear', 'cloud', 'dragon', 'eagle', 'flame', 'grape', 'hound',
  'iris', 'jade', 'koala', 'lamp', 'moon', 'nova', 'ocean', 'panda',
  'quill', 'river', 'storm', 'tiger', 'umbra', 'vault', 'wolf', 'zenith',
]

export function generateSlug(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const suffix = Math.floor(Math.random() * 1000)
  return `${adj}-${noun}-${suffix}`
}

export function generateUniqueSlug(exists: (s: string) => boolean): string {
  let slug = generateSlug()
  while (exists(slug)) slug = generateSlug()
  return slug
}
