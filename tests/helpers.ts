import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const exampleDir = fileURLToPath(new URL('../examples/search-service', import.meta.url))

export const sh = (cwd: string, cmd: string, args: string[]): string =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })

/** A real Git repository seeded from examples/search-service, with an isolated SIDEBET_HOME. */
export const makeRepo = async (): Promise<{ repo: string; home: string }> => {
  const base = await mkdtemp(join(tmpdir(), 'sidebet-test-'))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  await cp(exampleDir, repo, { recursive: true })
  sh(repo, 'git', ['init', '-q', '-b', 'main'])
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-qm', 'init'])
  return { repo, home }
}

export const write = (repo: string, path: string, content: string): Promise<void> =>
  writeFile(join(repo, path), content)
