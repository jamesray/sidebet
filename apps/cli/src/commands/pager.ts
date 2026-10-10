import { spawn } from 'node:child_process'
import { colorDiff, type Ui } from '../ui.js'

/** Show text through the user's pager when attached to a terminal, otherwise print it. */
export const showText = async (ui: Ui, text: string, isDiff = false): Promise<void> => {
  const body = isDiff ? colorDiff(ui, text) : text
  if (!process.stdout.isTTY || ui.json) {
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
    return
  }
  const pager = process.env.GIT_PAGER ?? process.env.PAGER ?? 'less -R'
  await new Promise<void>((resolve) => {
    const child = spawn('sh', ['-c', pager], { stdio: ['pipe', 'inherit', 'inherit'] })
    child.stdin.on('error', () => {})
    child.on('close', () => resolve())
    child.on('error', () => {
      process.stdout.write(body)
      resolve()
    })
    child.stdin.end(body)
  })
}
