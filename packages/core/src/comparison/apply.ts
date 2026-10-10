import type { ProjectContext } from '../config/load.js'
import { type Application, type HumanReview, SCHEMA_VERSION } from '../domain/schemas.js'
import {
  applyCheck,
  applyPatch,
  commitTree,
  diffPatch,
  headCommit,
  patchFiles,
  refExists,
  snapshotTree,
  statusLines,
  updateRef,
} from '../git/git.js'
import { findAttempt, type RunDetail } from '../runs/history.js'
import type { Storage } from '../storage.js'
import { SidebetError } from '../util/exec.js'
import { newId, nowIso } from '../util/ids.js'
import { backupRef } from './worktree.js'

export interface ApplyPreview {
  runId: string
  attemptId: string
  label: string
  model: string
  files: string[]
  /** Files the attempt changes that you have also modified locally. */
  locallyModified: string[]
  applies: boolean
  conflict?: string
  patch: string
  source: 'ref' | 'artifact'
}

const attemptPatch = async (
  project: ProjectContext,
  detail: RunDetail,
  label: string,
): Promise<{ patch: string; source: 'ref' | 'artifact' }> => {
  const a = findAttempt(detail, label)
  const { resultCommit, baseCommit, resultRef } = a.attempt
  if (resultCommit && baseCommit && resultRef && (await refExists(project.root, resultRef))) {
    return { patch: await diffPatch(project.root, baseCommit, resultCommit), source: 'ref' }
  }
  if (a.diff) {
    if (a.diff.content.includes('[diff truncated by Sidebet]')) {
      throw new SidebetError(
        'The stored diff was truncated and the Git ref for this attempt no longer exists.',
        'The attempt cannot be applied safely.',
      )
    }
    return { patch: a.diff.content, source: 'artifact' }
  }
  return { patch: '', source: 'artifact' }
}

export const previewApply = async (
  project: ProjectContext,
  detail: RunDetail,
  label: string,
  options: { allowIncomplete?: boolean } = {},
): Promise<ApplyPreview> => {
  const a = findAttempt(detail, label)
  if (detail.run.kind === 'run' && a.attempt.resultCommit === undefined) {
    throw new SidebetError(
      'This run edited your working tree directly, so there is nothing to apply.',
      'Use `sidebet runs diff` to see what it changed.',
    )
  }
  if (a.attempt.status !== 'completed' && !options.allowIncomplete) {
    throw new SidebetError(
      `Attempt ${a.attempt.label} ended as "${a.attempt.status}".`,
      'Its partial work is preserved. Pass --allow-incomplete to apply it anyway.',
    )
  }
  const { patch, source } = await attemptPatch(project, detail, label)
  if (!patch.trim())
    throw new SidebetError(`Attempt ${a.attempt.label} made no changes; nothing to apply.`)
  const files = await patchFiles(project.root, patch)
  const check = await applyCheck(project.root, patch)
  const dirty = new Set((await statusLines(project.root)).map((l) => l.slice(3)))
  return {
    runId: detail.run.id,
    attemptId: a.attempt.id,
    label: a.attempt.label,
    model: `${a.attempt.provider}/${a.attempt.model}`,
    files,
    locallyModified: files.filter((f) => dirty.has(f)),
    applies: check.ok,
    conflict: check.error,
    patch,
    source,
  }
}

/**
 * Apply an attempt's patch to the working tree (never the index, never a commit).
 * Before touching anything a recoverable snapshot of the working tree is stored under refs/sidebet/backups.
 */
export const applyAttempt = async (
  project: ProjectContext,
  storage: Storage,
  preview: ApplyPreview,
): Promise<Application> => {
  if (!preview.applies) {
    throw new SidebetError(
      `Attempt ${preview.label} does not apply cleanly to your working tree:\n${preview.conflict ?? ''}`,
      'Nothing was changed. Commit or stash conflicting edits and retry, or apply the diff by hand.',
    )
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const ref = backupRef(preview.runId, stamp)
  const tree = await snapshotTree(project.root)
  const commit = await commitTree(
    project.root,
    tree,
    `sidebet: backup before applying ${preview.runId}/${preview.label}`,
    await headCommit(project.root),
  )
  await updateRef(project.root, ref, commit)
  await applyPatch(project.root, preview.patch)
  const application: Application = {
    id: newId('app'),
    schemaVersion: SCHEMA_VERSION,
    runId: preview.runId,
    attemptId: preview.attemptId,
    backupRef: ref,
    resultRef: `refs/sidebet/runs/${preview.runId}/${preview.label}`,
    files: preview.files,
    createdAt: nowIso(),
  }
  storage.records.put('application', application)
  return application
}

export interface ReviewInput {
  runId: string
  preferred?: string
  accepted: boolean
  reason?: string
  notes?: string
}

export const recordReview = (
  storage: Storage,
  detail: RunDetail,
  input: ReviewInput,
): HumanReview => {
  const preferred = input.preferred ? findAttempt(detail, input.preferred).attempt.id : undefined
  const review: HumanReview = {
    id: newId('rev'),
    schemaVersion: SCHEMA_VERSION,
    runId: detail.run.id,
    preferredAttemptId: preferred,
    accepted: input.accepted,
    reason: input.reason,
    notes: input.notes,
    createdAt: nowIso(),
  }
  storage.records.put('review', review)
  return review
}
