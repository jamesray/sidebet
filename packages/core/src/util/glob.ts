const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

const globToSource = (glob: string): string => {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c !== undefined) {
      out += escapeRe(c)
    }
  }
  return out
}

/**
 * Gitignore-flavoured matching on POSIX-style relative paths.
 * A pattern without a slash matches that name at any depth (".env" matches "a/.env").
 * A pattern ending in "/**" or "/" matches everything beneath the directory.
 */
export const matchesGlob = (relPath: string, pattern: string): boolean => {
  const path = relPath.replace(/^\.\//, '').replace(/\\/g, '/')
  let pat = pattern.replace(/^\.\//, '')
  if (pat.endsWith('/')) pat = `${pat}**`
  const anchored = pat.includes('/')
  const source = globToSource(pat)
  const re = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`)
  return re.test(path)
}

export const matchesAny = (relPath: string, patterns: readonly string[]): string | undefined =>
  patterns.find((p) => matchesGlob(relPath, p))

/** Matches "provider/model" style ids with * wildcards. */
export const matchesModelPattern = (id: string, pattern: string): boolean => {
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`)
  return re.test(id)
}
