import { randomBytes } from 'crypto'

const adjectives = [
  'quick', 'brave', 'calm', 'daring', 'eager', 'fancy', 'gentle', 'happy',
  'icy', 'jolly', 'kind', 'lucky', 'merry', 'nice', 'odd', 'proud',
  'quiet', 'rapid', 'swift', 'tidy', 'ultra', 'vivid', 'warm', 'zesty',
  'ancient', 'arcane', 'astral', 'celestial', 'chaotic', 'cursed',
  'divine', 'ember', 'enchanted', 'ethereal', 'fabled', 'feral',
  'gilded', 'golden', 'hallowed', 'heroic', 'immortal', 'legendary',
  'lunar', 'mystic', 'mythical', 'phantom', 'primal', 'radiant',
  'royal', 'runic', 'sacred', 'shadow', 'silver', 'solar', 'spectral',
  'stellar', 'thunder', 'twilight', 'valiant', 'void', 'wicked',
]
const nouns = [
  'apple', 'bear', 'cloud', 'dragon', 'eagle', 'flame', 'grape', 'hound',
  'iris', 'jade', 'koala', 'lamp', 'moon', 'nova', 'ocean', 'panda',
  'quill', 'river', 'storm', 'tiger', 'umbra', 'vault', 'wolf', 'zenith',
  'assassin', 'behemoth', 'berserker', 'blade', 'chimera', 'cleric',
  'comet', 'crystal', 'dragoon', 'druid', 'dungeon', 'elf', 'fairy',
  'falcon', 'fenrir', 'fortress', 'gargoyle', 'goblin', 'griffin',
  'guild', 'hydra', 'katana', 'knight', 'kraken', 'leviathan', 'lich',
  'mage', 'mana', 'mecha', 'meteor', 'ninja', 'oracle', 'paladin',
  'phoenix', 'pixie', 'portal', 'potion', 'prism', 'ranger', 'relic',
  'rogue', 'rune', 'samurai', 'scroll', 'sentinel', 'seraph', 'shaman',
  'shinobi', 'sigil', 'siren', 'sorcerer', 'spirit', 'sprite',
  'summoner', 'talisman', 'titan', 'valkyrie', 'vampire', 'wizard',
  'wyvern', 'yokai', 'zephyr',
]

export function generateSlug(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const suffix = randomBytes(4).toString('hex').slice(0, 6)
  return `${adj}-${noun}-${suffix}`
}

export function generateUniqueSlug(exists: (s: string) => boolean): string {
  let slug = generateSlug()
  while (exists(slug)) slug = generateSlug()
  return slug
}
