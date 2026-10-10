import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRepo } from '../helpers.js'

const bin = fileURLToPath(new URL('../../apps/cli/dist/bin.js', import.meta.url))
const model = process.env.SIDEBET_TEST_MODEL

/**
 * Optional, makes ONE small paid model call. Run with:
 *   SIDEBET_INTEGRATION=1 SIDEBET_TEST_MODEL=provider/model pnpm test:integration
 */
describe.skipIf(!model)('real Pi + real provider', () => {
  it('runs a read-only task end to end', async () => {
    const { repo, home } = await makeRepo()
    const r = spawnSync(
      'node',
      [
        bin,
        'run',
        'Reply with exactly the word: ok',
        '--readonly',
        '--model',
        model ?? '',
        '--json',
      ],
      {
        cwd: repo,
        env: { ...process.env, SIDEBET_HOME: home },
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    const detail = JSON.parse(r.stdout) as {
      run: { status: string }
      attempts: Array<{ usage?: { totalTokens: number } }>
    }
    expect(detail.run.status).toBe('completed')
    expect(detail.attempts[0]?.usage?.totalTokens).toBeGreaterThan(0)
  })
})
