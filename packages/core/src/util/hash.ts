import { createHash } from 'node:crypto'

export const sha256 = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex')

/** Stable JSON: object keys sorted, so equal values hash equally. */
export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    }
    return v
  })

export const hashOf = (value: unknown): string => sha256(stableStringify(value))
