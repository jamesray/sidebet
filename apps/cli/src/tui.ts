import {
  Container,
  Input,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
} from '@earendil-works/pi-tui'
import { hr } from './style/draw.js'
import type { Palette } from './style/palette.js'

export interface MenuItem {
  value: string
  label: string
  description?: string
}

export const canUseTui = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY)

const selectTheme = (p: Palette) => ({
  selectedPrefix: (t: string) => p.fg('accent')(t),
  selectedText: (t: string) => p.bold(p.fg('accent')(t)),
  description: (t: string) => p.fg('muted')(t),
  scrollInfo: (t: string) => p.dim(t),
  noMatch: (t: string) => p.fg('warning')(t),
})

/**
 * Inline menu (regular screen, so it stays in scrollback). Resolves with the chosen value, or
 * undefined on Escape / Ctrl+C.
 */
export const selectMenu = (
  p: Palette,
  title: string,
  items: MenuItem[],
  hint = '↑↓ move · enter choose · esc back',
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const tui = new TuiMainScreen(new ProcessTerminal(), false)
    const root = new Container()
    root.addChild(new Text(p.bold(p.fg('text')(title))))
    const list = new SelectList(items, Math.min(items.length, 12), selectTheme(p))
    root.addChild(list)
    root.addChild(new Text(p.dim(hint)))
    tui.addChild(root)
    let done = false
    const finish = (value: string | undefined): void => {
      if (done) return
      done = true
      tui.stop()
      resolve(value)
    }
    list.onSelect = (item) => finish(item.value)
    list.onCancel = () => finish(undefined)
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        finish(undefined)
        return { consume: true }
      }
      list.handleInput(data)
      tui.requestRender()
      return { consume: true }
    })
    tui.start()
  })

/** Single-line prompt rendered inline. Empty submit resolves to ''. Escape resolves to undefined. */
export const askLine = (
  p: Palette,
  prompt: string,
  placeholder = '',
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const tui = new TuiMainScreen(new ProcessTerminal(), true)
    const input = new Input({
      prompt: `${p.fg('accent')('›')} `,
      placeholder,
      placeholderStyle: p.dim,
    })
    const root = new Container()
    root.addChild(new Text(p.fg('text')(prompt)))
    root.addChild(input)
    tui.addChild(root)
    tui.setFocus(input)
    let done = false
    const finish = (v: string | undefined): void => {
      if (done) return
      done = true
      tui.stop()
      resolve(v)
    }
    input.onSubmit = (v) => finish(v.trim())
    input.onEscape = () => finish(undefined)
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        finish(undefined)
        return { consume: true }
      }
      input.handleInput(data)
      tui.requestRender()
      return { consume: true }
    })
    tui.start()
  })

export const confirmTui = async (p: Palette, question: string): Promise<boolean> => {
  const v = await selectMenu(p, question, [
    { value: 'no', label: 'No', description: 'leave everything as it is' },
    { value: 'yes', label: 'Yes' },
  ])
  return v === 'yes'
}

/**
 * Full-screen, scrollable viewer for long text (diffs). Keys: ↑↓/jk, space/pgdn, pgup, g/G, q/esc.
 * Resolves when the viewer closes; the regular screen is restored untouched.
 */
export const viewText = (p: Palette, title: string, lines: string[]): Promise<void> =>
  new Promise((resolve) => {
    const tui = new TuiAltScreen(new ProcessTerminal(), false)
    const body = new Container()
    body.addChild(
      new Text(
        `${p.bold(p.fg('accent')(title))}  ${p.dim('q close · ↑↓ j k scroll · space pgdn · g/G top/bottom')}`,
      ),
    )
    body.addChild(new Text(hr(200, p.fg('border'))))
    body.addChild(new Text(lines.join('\n')))
    tui.setLayoutRoot(body)
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      tui.stop()
      resolve()
    }
    const page = Math.max(5, (process.stdout.rows ?? 30) - 3)
    tui.addInputListener((data) => {
      if (matchesKey(data, 'q') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c'))
        finish()
      else if (matchesKey(data, 'down') || matchesKey(data, 'j')) tui.scrollBy(1)
      else if (matchesKey(data, 'up') || matchesKey(data, 'k')) tui.scrollBy(-1)
      else if (
        matchesKey(data, 'pageDown') ||
        matchesKey(data, 'space') ||
        matchesKey(data, 'ctrl+d')
      )
        tui.scrollBy(page)
      else if (matchesKey(data, 'pageUp') || matchesKey(data, 'ctrl+u')) tui.scrollBy(-page)
      else if (matchesKey(data, 'g')) tui.scrollToTop()
      else if (matchesKey(data, 'shift+g')) tui.scrollToBottom()
      tui.requestRender()
      return { consume: true }
    })
    tui.start()
  })

/** Pi's diff renderer when available (intra-line highlights), otherwise a plain colouring. */
export const renderDiffLines = async (p: Palette, patch: string): Promise<string[]> => {
  try {
    const { renderDiff } = await import('@earendil-works/pi-coding-agent')
    return renderDiff(patch).split('\n')
  } catch {
    return patch
      .split('\n')
      .map((l) =>
        l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
          ? p.bold(l)
          : l.startsWith('+')
            ? p.fg('success')(l)
            : l.startsWith('-')
              ? p.fg('error')(l)
              : l.startsWith('@@')
                ? p.fg('info')(l)
                : p.fg('muted')(l),
      )
  }
}
