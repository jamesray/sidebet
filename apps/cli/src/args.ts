import { parseArgs } from 'node:util'
import { SidebetError } from '@sidebet/core'

type OptionSpec = Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }>

export interface Parsed<T extends OptionSpec> {
  values: {
    [K in keyof T]?: T[K]['multiple'] extends true
      ? string[]
      : T[K]['type'] extends 'boolean'
        ? boolean
        : string
  }
  positionals: string[]
}

export const parse = <T extends OptionSpec>(args: string[], options: T): Parsed<T> => {
  try {
    const r = parseArgs({ args, options, allowPositionals: true, strict: true })
    return r as unknown as Parsed<T>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SidebetError(msg.replace(/^.*?: /, ''), 'Run `sidebet help` for usage.')
  }
}
