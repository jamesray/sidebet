import { z } from 'zod'
import { RawPolicySchema } from '../policy/schema.js'

export const CONFIG_VERSION = 1

export const ConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  projectId: z.string().optional(),
  name: z.string().optional(),
  runtime: z.string().default('pi'),
  models: z
    .object({
      /** "provider/model-id". Falls back to Pi's default model. */
      default: z.string().optional(),
      /** Models used by `sidebet compare` when --models is not given. */
      compare: z.array(z.string()).optional(),
      /** Short names for models you are logged into in Pi, e.g. { "fast": "anthropic/claude-haiku-4-5" }. */
      aliases: z.record(z.string(), z.string()).default({}),
    })
    .default({ aliases: {} }),
  tests: z
    .object({
      command: z.string().optional(),
      timeoutSec: z.number().positive().default(600),
    })
    .default({ timeoutSec: 600 }),
  context: z
    .object({
      budgetTokens: z.number().int().positive().default(12000),
      perItemTokens: z.number().int().positive().default(3000),
      docs: z
        .array(z.string())
        .default(['ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'CONTRIBUTING.md']),
      memoryLimit: z.number().int().positive().default(8),
      /** At or below this many memories in scope, all are included rather than searched. */
      memoryIncludeAllBelow: z.number().int().nonnegative().default(5),
    })
    .default({
      budgetTokens: 12000,
      perItemTokens: 3000,
      docs: ['ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'CONTRIBUTING.md'],
      memoryLimit: 8,
      memoryIncludeAllBelow: 5,
    }),
  compare: z
    .object({
      concurrency: z.number().int().positive().default(4),
      timeoutSec: z.number().positive().default(900),
      /** snapshot: attempts start from your working tree incl. uncommitted changes. refuse: stop if dirty. */
      uncommitted: z.enum(['snapshot', 'refuse']).default('snapshot'),
      /** Paths symlinked from the repo into each worktree (excluded from diffs). */
      linkPaths: z.array(z.string()).default(['node_modules']),
      /** Optional command run in each worktree before the agent starts. */
      setup: z.string().optional(),
      keepWorktrees: z.boolean().default(false),
    })
    .default({
      concurrency: 4,
      timeoutSec: 900,
      uncommitted: 'snapshot',
      linkPaths: ['node_modules'],
      keepWorktrees: false,
    }),
  run: z
    .object({
      timeoutSec: z.number().positive().default(1800),
      runTests: z.boolean().default(false),
      /** When true, plain `sidebet run` automatically runs models.compare side by side (dual output). */
      dual: z.boolean().default(false),
    })
    .default({ timeoutSec: 1800, runTests: false, dual: false }),
  policy: RawPolicySchema.default({}),
})
export type SidebetConfig = z.infer<typeof ConfigSchema>
export type EffectiveConfig = Omit<SidebetConfig, 'policy'>
