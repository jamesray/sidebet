/* Sidebet marketing site: hero dashboard animation, tabs, copy buttons, reveal, interest form. */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---------- Helpers ---------- */

const fmtDuration = (s) => {
  const sec = Math.max(0, Math.round(s))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return `${m}m ${String(r).padStart(2, '0')}s`
}

const fmtTokens = (n) => {
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(1)}k`
}

const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const sparkline = (values) => {
  if (values.length < 2) return ''
  const max = Math.max(...values)
  return values.map((v) => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('')
}

/* ---------- Hero dashboard ---------- */

// Each lane is a script of (simulated second, activity) pairs plus the numbers the run ends on.
const LANES = {
  a: {
    finish: 178,
    firstEdit: 41,
    turns: 6,
    turnAt: [0, 30, 60, 95, 130, 160],
    perTurn: [180, 420, 760, 910, 520, 310],
    tools: 14,
    tokens: 48200,
    outRatio: 0.064,
    cost: 0.21,
    blocked: 0,
    script: [
      [0, 'creating worktree'],
      [3, 'read AGENTS.md'],
      [9, 'read src/search.ts'],
      [15, 'grep "toLowerCase" src/'],
      [22, 'read test/search.test.ts'],
      [30, 'thinking'],
      [41, 'edit src/search.ts'],
      [55, 'write test/search.test.ts'],
      [70, 'bash pnpm test'],
      [95, 'edit src/search.ts'],
      [115, 'bash pnpm test'],
      [140, 'read src/index.ts'],
      [155, 'capturing changes'],
      [165, 'running tests: pnpm test'],
    ],
  },
  b: {
    finish: 211,
    firstEdit: 72,
    turns: 9,
    turnAt: [0, 25, 50, 72, 95, 120, 150, 175, 195],
    perTurn: [210, 260, 390, 640, 820, 560, 410, 300, 190],
    tools: 21,
    tokens: 61700,
    outRatio: 0.062,
    cost: undefined,
    blocked: 1,
    blockedAt: 58,
    script: [
      [0, 'creating worktree'],
      [3, 'read AGENTS.md'],
      [10, "find . -name '*.ts'"],
      [18, 'read src/search.ts'],
      [26, 'read src/index.ts'],
      [34, 'read test/search.test.ts'],
      [45, 'grep -r "search" src/'],
      [58, 'bash cat .env'],
      [72, 'edit src/search.ts'],
      [90, 'edit src/types.ts'],
      [105, 'write test/search.test.ts'],
      [120, 'bash pnpm test'],
      [150, 'edit test/search.test.ts'],
      [170, 'bash pnpm test'],
      [190, 'capturing changes'],
      [198, 'running tests: pnpm test'],
    ],
  },
}

const SIM_RATE = 26 // simulated seconds per real second
const HOLD_MS = 7000

const initHero = () => {
  const term = document.getElementById('hero-term')
  if (!term) return
  const detail = document.getElementById('hd-detail')
  const hint = document.getElementById('hd-hint')
  const summary = document.getElementById('hero-summary')
  const cards = {}
  for (const el of term.querySelectorAll('[data-card]')) {
    const fields = {}
    for (const f of el.querySelectorAll('[data-f]')) fields[f.dataset.f] = f
    cards[el.dataset.card] = fields
  }

  const renderLane = (key, t, tick) => {
    const lane = LANES[key]
    const f = cards[key]
    if (!f) return
    const done = t >= lane.finish
    const tt = Math.min(t, lane.finish)
    const progress = smooth(tt / lane.finish)
    const total = lane.tokens * progress
    const out = total * lane.outRatio
    const turns = lane.turnAt.filter((at) => at <= tt).length
    const tools = Math.round(lane.tools * progress)
    const blocked = lane.blocked && tt >= lane.blockedAt ? lane.blocked : 0
    let activity = lane.script[0][1]
    for (const [at, text] of lane.script) if (at <= tt) activity = text

    f.status.dataset.state = done ? 'completed' : 'running'
    f.glyph.textContent = done ? '✓' : SPINNER[tick % SPINNER.length]
    f.word.textContent = done ? 'completed' : 'running'
    f.elapsed.textContent = fmtDuration(tt)
    f.firstedit.textContent =
      tt >= lane.firstEdit ? ` · first edit ${fmtDuration(lane.firstEdit)}` : ''
    f.tokens.textContent = fmtTokens(total)
    f.io.textContent = `↑${fmtTokens(total - out)} ↓${fmtTokens(out)}`
    f.turns.textContent = String(turns)
    f.spark.textContent = sparkline(lane.perTurn.slice(0, turns))
    f.tools.textContent = String(tools)
    f.blocked.textContent = blocked ? `${blocked} blocked` : ''
    if (lane.cost !== undefined) {
      f.cost.textContent = `$${(lane.cost * progress).toFixed(2)}`
      f.cost.classList.remove('t-dim')
    } else {
      f.cost.textContent = 'cost n/a'
      f.cost.classList.add('t-dim')
    }
    f.activity.textContent = done ? 'done' : activity
    f.activity.classList.toggle('done', done)
    f.badge.textContent = done ? 'completed' : ''
  }

  const render = (t, tick) => {
    renderLane('a', t, tick)
    renderLane('b', t, tick)
    const running = Object.values(LANES).filter((l) => t < l.finish).length
    const end = Math.max(LANES.a.finish, LANES.b.finish)
    detail.textContent = `2 attempts · ${running} running · ${fmtDuration(Math.min(t, end))}`
    hint.textContent = running ? 'ctrl+c cancel' : ''
    summary.classList.toggle('show', running === 0)
  }

  const END = Math.max(LANES.a.finish, LANES.b.finish) + 1
  if (reduceMotion) {
    render(END, 0)
    return
  }

  let start = performance.now()
  let tick = 0
  let holdUntil = 0
  const frame = (now) => {
    if (holdUntil) {
      if (now >= holdUntil) {
        holdUntil = 0
        start = now
      }
      requestAnimationFrame(frame)
      return
    }
    const t = ((now - start) / 1000) * SIM_RATE
    tick = Math.floor(now / 90)
    render(Math.min(t, END), tick)
    if (t >= END) holdUntil = now + HOLD_MS
    requestAnimationFrame(frame)
  }
  // Only animate while visible; saves battery and keeps the loop in sync when the tab returns.
  let raf = 0
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !raf) {
          start = performance.now()
          raf = requestAnimationFrame(frame)
        } else if (!e.isIntersecting && raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
      }
    },
    { threshold: 0.15 },
  )
  io.observe(term)
  render(0, 0)
}

/* ---------- Tabs ---------- */

const initTabs = () => {
  const list = document.querySelector('[role="tablist"]')
  if (!list) return
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')))
  const select = (index, focus) => {
    tabs.forEach((tab, i) => {
      const on = i === index
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
      tab.tabIndex = on ? 0 : -1
      if (panels[i]) panels[i].dataset.active = on ? 'true' : 'false'
      if (on && focus) tab.focus()
    })
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i, false))
    tab.addEventListener('keydown', (e) => {
      const n = tabs.length
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') select((i + 1) % n, true)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') select((i - 1 + n) % n, true)
      else if (e.key === 'Home') select(0, true)
      else if (e.key === 'End') select(n - 1, true)
      else return
      e.preventDefault()
    })
  })
}

/* ---------- Copy buttons ---------- */

const initCopy = () => {
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const target = document.querySelector(btn.dataset.copy)
      if (!target) return
      const text = target.innerText.replace(/\s+#.*$/gm, '').trim()
      try {
        await navigator.clipboard.writeText(text)
        btn.dataset.copied = 'true'
        const label = btn.getAttribute('aria-label')
        btn.setAttribute('aria-label', 'Copied')
        setTimeout(() => {
          delete btn.dataset.copied
          if (label) btn.setAttribute('aria-label', label)
        }, 1600)
      } catch {
        // Clipboard unavailable (insecure context or permissions); select the text instead.
        const range = document.createRange()
        range.selectNodeContents(target)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
  }
}

/* ---------- Reveal on scroll ---------- */

const initReveal = () => {
  const items = document.querySelectorAll('.reveal')
  if (reduceMotion || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('in')
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io.unobserve(e.target)
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  )
  for (const el of items) io.observe(el)
}

/* ---------- Interest form ----------
 * Set data-endpoint on the form to a URL that accepts a POST with an `email` field
 * (Buttondown, Formspree, a Cloudflare Worker, ...). With no endpoint configured the form is
 * replaced by GitHub links, so nothing on the page pretends to work when it does not.
 */

const initInterest = () => {
  const form = document.getElementById('interest-form')
  const links = document.getElementById('interest-links')
  if (!form || !links) return
  const endpoint = form.dataset.endpoint
  if (!endpoint) {
    form.hidden = true
    links.hidden = false
    return
  }
  const note = document.getElementById('interest-note')
  const input = form.querySelector('input[type="email"]')
  const button = form.querySelector('button')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!input.value || !input.checkValidity()) {
      note.textContent = 'That does not look like an email address.'
      input.focus()
      return
    }
    button.disabled = true
    note.textContent = 'Sending…'
    try {
      const body = new URLSearchParams({ email: input.value })
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body,
      })
      if (!res.ok) throw new Error(String(res.status))
      note.textContent = 'Thanks. You will hear from us when there is something to show.'
      input.value = ''
    } catch {
      note.textContent = 'That did not go through. You can watch releases on GitHub instead.'
      links.hidden = false
    } finally {
      button.disabled = false
    }
  })
}

/* ---------- Boot ---------- */

initHero()
initTabs()
initCopy()
initReveal()
initInterest()
const year = document.getElementById('year')
if (year) year.textContent = String(new Date().getFullYear())
