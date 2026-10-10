import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface SkillInfo {
  name: string
  description: string
  path: string
  scope: 'global' | 'project'
}

const parseFrontmatter = (text: string): Record<string, string> => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m?.[1]) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv?.[1] && kv[2] !== undefined) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

const readSkillFile = async (
  file: string,
  fallbackName: string,
  scope: SkillInfo['scope'],
): Promise<SkillInfo | undefined> => {
  try {
    const fm = parseFrontmatter(await readFile(file, 'utf8'))
    return { name: fm.name ?? fallbackName, description: fm.description ?? '', path: file, scope }
  } catch {
    return undefined
  }
}

const scanDir = async (
  dir: string,
  scope: SkillInfo['scope'],
  rootMarkdown: boolean,
  depth = 0,
): Promise<SkillInfo[]> => {
  if (!existsSync(dir) || depth > 3) return []
  const out: SkillInfo[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory() || e.isSymbolicLink()) {
      const skillMd = join(full, 'SKILL.md')
      if (existsSync(skillMd)) {
        const s = await readSkillFile(skillMd, e.name, scope)
        if (s) out.push(s)
      } else if (e.isDirectory()) {
        out.push(...(await scanDir(full, scope, false, depth + 1)))
      }
    } else if (rootMarkdown && depth === 0 && e.name.endsWith('.md')) {
      const s = await readSkillFile(full, e.name.replace(/\.md$/, ''), scope)
      if (s) out.push(s)
    }
  }
  return out
}

/**
 * Find Agent-Skills-compatible skills Pi would load: project `.pi/skills` and `.agents/skills`
 * plus the runtime's global directories. Names are deduplicated, project first.
 */
export const discoverSkills = async (root: string, globalDirs: string[]): Promise<SkillInfo[]> => {
  const found: SkillInfo[] = []
  found.push(...(await scanDir(join(root, '.pi', 'skills'), 'project', true)))
  found.push(...(await scanDir(join(root, '.agents', 'skills'), 'project', false)))
  for (const d of globalDirs)
    found.push(...(await scanDir(resolve(d), 'global', d.includes('.pi'))))
  const seen = new Set<string>()
  return found.filter((s) => {
    if (seen.has(s.name)) return false
    seen.add(s.name)
    return true
  })
}
