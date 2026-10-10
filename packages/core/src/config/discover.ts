import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverSkills, type SkillInfo } from '../context/skills.js'
import { currentBranch, headCommit, statusLines } from '../git/git.js'
import type { RuntimeInfo } from '../runtime.js'
import { packageJsonName } from './load.js'
import { projectRulesDir } from './paths.js'

export interface Discovery {
  root: string
  name: string
  git: { branch?: string; head?: string; dirty: boolean }
  languages: string[]
  packageManager?: string
  testCommand?: string
  agentsMd?: string
  rulesFiles: string[]
  skills: SkillInfo[]
}

const has = (root: string, ...names: string[]): boolean =>
  names.some((n) => existsSync(join(root, n)))

export const detectPackageManager = (root: string): string | undefined => {
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (has(root, 'yarn.lock')) return 'yarn'
  if (has(root, 'bun.lock', 'bun.lockb')) return 'bun'
  if (has(root, 'package-lock.json', 'npm-shrinkwrap.json')) return 'npm'
  if (has(root, 'uv.lock')) return 'uv'
  if (has(root, 'poetry.lock')) return 'poetry'
  if (has(root, 'Cargo.toml')) return 'cargo'
  if (has(root, 'go.mod')) return 'go'
  if (has(root, 'package.json')) return 'npm'
  if (has(root, 'requirements.txt', 'pyproject.toml')) return 'pip'
  return undefined
}

export const detectLanguages = (root: string): string[] => {
  const langs: string[] = []
  if (has(root, 'tsconfig.json')) langs.push('TypeScript')
  else if (has(root, 'package.json')) langs.push('JavaScript')
  if (has(root, 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile')) langs.push('Python')
  if (has(root, 'Cargo.toml')) langs.push('Rust')
  if (has(root, 'go.mod')) langs.push('Go')
  if (has(root, 'Gemfile')) langs.push('Ruby')
  if (has(root, 'pom.xml', 'build.gradle', 'build.gradle.kts')) langs.push('Java')
  return langs
}

export const detectTestCommand = async (
  root: string,
  pm: string | undefined,
): Promise<string | undefined> => {
  if (has(root, 'package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
      const script = pkg.scripts?.test
      if (script && !/no test specified/.test(script)) {
        return pm === 'bun' ? 'bun run test' : `${pm === 'yarn' || pm === 'pnpm' ? pm : 'npm'} test`
      }
    } catch {
      // unreadable package.json: fall through to other ecosystems
    }
  }
  if (has(root, 'Cargo.toml')) return 'cargo test'
  if (has(root, 'go.mod')) return 'go test ./...'
  if (has(root, 'pytest.ini', 'tox.ini') || has(root, 'tests', 'test')) {
    if (has(root, 'pyproject.toml', 'pytest.ini', 'requirements.txt', 'setup.py')) return 'pytest'
  }
  if (has(root, 'Makefile')) {
    const mk = await readFile(join(root, 'Makefile'), 'utf8').catch(() => '')
    if (/^test:/m.test(mk)) return 'make test'
  }
  return undefined
}

export const discoverProject = async (root: string, runtime?: RuntimeInfo): Promise<Discovery> => {
  const pm = detectPackageManager(root)
  const rulesDir = projectRulesDir(root)
  const rulesFiles = existsSync(rulesDir)
    ? (await readdir(rulesDir))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `.sidebet/rules/${f}`)
    : []
  return {
    root,
    name: (await packageJsonName(root)) ?? root.split('/').pop() ?? 'project',
    git: {
      branch: await currentBranch(root),
      head: await headCommit(root),
      dirty: (await statusLines(root)).length > 0,
    },
    languages: detectLanguages(root),
    packageManager: pm,
    testCommand: await detectTestCommand(root, pm),
    agentsMd: has(root, 'AGENTS.md') ? 'AGENTS.md' : undefined,
    rulesFiles,
    skills: await discoverSkills(root, runtime?.skillDirs ?? []),
  }
}
