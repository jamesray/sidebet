import type { MemoryStore } from '../storage.js'

const SIGNAL =
  /\b(always|never|must|must not|should not|shouldn't|do not|don't|convention|deprecated|requires?|note that|remember|careful|gotcha|only works|known issue|slow|flaky|be sure|make sure)\b/i

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Propose memory candidates from an agent's final summary. Purely heuristic and never persisted:
 * the caller must show them to a human and save only what they approve.
 */
export const suggestMemories = (
  summary: string,
  memory: MemoryStore,
  projectId: string,
  max = 5,
): string[] => {
  const existing = new Set(memory.list({ projectId }).map((m) => normalize(m.text)))
  const pieces = summary
    .split(/\n+|(?<=[.!?])\s+/)
    .map((p) => p.replace(/^[\s>*\-•\d.)]+/, '').trim())
    .filter((p) => p.length >= 20 && p.length <= 240)
  const out: string[] = []
  for (const p of pieces) {
    if (!SIGNAL.test(p)) continue
    const n = normalize(p)
    if (existing.has(n) || out.some((o) => normalize(o) === n)) continue
    out.push(p)
    if (out.length >= max) break
  }
  return out
}
