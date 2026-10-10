import { randomBytes } from 'node:crypto'

export type IdPrefix =
  | 'prj'
  | 'run'
  | 'att'
  | 'ctx'
  | 'tev'
  | 'use'
  | 'art'
  | 'tst'
  | 'evl'
  | 'rev'
  | 'app'
  | 'mem'
  | 'bet'

export const newId = (prefix: IdPrefix): string => `${prefix}_${randomBytes(4).toString('hex')}`

export const nowIso = (): string => new Date().toISOString()
