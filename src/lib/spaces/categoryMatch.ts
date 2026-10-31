// The key two category names match on when records move between spaces:
// trimmed, inner whitespace collapsed, lowercased, diacritics removed (the same
// rule as normalizeForMatch in suggestions.ts). Pure, no imports.

export function categoryMatchKey(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}
