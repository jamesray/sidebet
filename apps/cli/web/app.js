// Sidebet local web app. Plain ES module: no build step, no dependencies.
//
// It talks to the JSON API served by `sidebet ui` (apps/cli/src/server). Reads are open to this
// page; every mutation carries the per-process token from <meta name="sidebet-token">, which the
// server requires and which forces a CORS preflight that other origins never get past.

const TOKEN = document.querySelector('meta[name="sidebet-token"]')?.content ?? ''
const VIEWS = ['runs', 'new', 'odds', 'memory', 'context', 'policy', 'doctor', 'settings']
const CATEGORIES = ['bugfix', 'feature', 'refactor', 'test', 'docs', 'question', 'other']

// ---------- DOM and formatting ----------

const $ = (sel, el = document) => el.querySelector(sel)

/** Build an element: attributes, `on*` listeners, boolean props; children are nodes or text. */
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat(Number.POSITIVE_INFINITY)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  }
  return el
}

/** replaceChildren() would render null as the text "null"; this drops it like h() does. */
const fill = (el, kids) =>
  el.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false))

const fmtDur = (ms) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}
const fmtTok = (n) => (n === null || n === undefined ? '–' : n.toLocaleString('en-US'))
const compact = (n) =>
  n < 1000 ? String(n) : n < 100000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
const fmtCost = (c) =>
  c === null || c === undefined
    ? 'not reported'
    : c < 0.01
      ? `$${c.toFixed(4)}`
      : `$${c.toFixed(2)}`
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const pill = (s) => h('span', { class: `pill ${s}` }, s)
const modelRef = (a) => `${a.provider}/${a.model}`
const testText = (a) => {
  const t = a.tests?.[0]
  if (!t) return 'not run'
  if (t.status === 'skipped') return `skipped${t.note ? ` (${t.note})` : ''}`
  const counts =
    t.passed !== undefined && t.passed !== null
      ? ` (${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''})`
      : ''
  return `${t.status}${counts}`
}
/** Elapsed time that keeps ticking (see the clock at the bottom). */
const since = (startIso, endIso) =>
  h(
    'span',
    { 'data-since': startIso, 'data-until': endIso },
    fmtDur((endIso ? new Date(endIso) : Date.now()) - new Date(startIso)),
  )

// ---------- API ----------

class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.status = status
    this.data = data ?? {}
  }
}

const api = async (path, { method = 'GET', body } = {}) => {
  const headers = {}
  if (method !== 'GET') {
    headers['x-sidebet-token'] = TOKEN
    if (body !== undefined) headers['content-type'] = 'application/json'
  }
  const r = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(data.error || r.statusText, r.status, data)
  return data
}
const get = (p) => api(p)
const post = (p, body) => api(p, { method: 'POST', body: body ?? {} })
const put = (p, body) => api(p, { method: 'PUT', body })
const del = (p) => api(p, { method: 'DELETE' })

// ---------- toasts and modals ----------

const toast = (msg, kind = '') => {
  const el = h('div', { class: `toast ${kind}` }, msg)
  $('#toasts').append(el)
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500)
}
const fail = (e) => {
  const hint = e?.data?.hint ? ` ${e.data.hint}` : ''
  toast(`${e?.message || String(e)}${hint}`, 'err')
}

/**
 * One dialog for everything. `actions[].run` may do async work; return false from it to keep the
 * dialog open (validation), anything else closes it with that value.
 */
const modal = ({ title, body, actions = [{ label: 'Close', value: null }] }) =>
  new Promise((resolve) => {
    const dlg = $('#modal')
    const close = (v) => {
      dlg.close()
      dlg.replaceChildren()
      resolve(v)
    }
    const buttons = actions.map((a) => {
      const b = h(
        'button',
        {
          class: a.primary ? 'primary' : a.danger ? 'danger' : '',
          disabled: a.disabled,
          onclick: async () => {
            if (!a.run) return close(a.value)
            b.disabled = true
            try {
              const r = await a.run()
              if (r === false) {
                b.disabled = false
                return
              }
              close(r === undefined ? a.value : r)
            } catch (e) {
              b.disabled = false
              fail(e)
            }
          },
        },
        a.label,
      )
      return b
    })
    dlg.replaceChildren(
      h(
        'div',
        { class: 'm-head' },
        title,
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost sm', onclick: () => close(null), 'aria-label': 'Close' }, '✕'),
      ),
      h('div', { class: 'm-body' }, body),
      h('div', { class: 'm-foot' }, ...buttons),
    )
    dlg.oncancel = (e) => {
      e.preventDefault()
      close(null)
    }
    dlg.showModal()
  })

const confirmModal = (title, message, label = 'Confirm', danger = false) =>
  modal({
    title,
    body: typeof message === 'string' ? h('p', {}, message) : message,
    actions: [
      { label: 'Cancel', value: false },
      { label, primary: !danger, danger, value: true },
    ],
  })

// ---------- state and routing ----------

const state = {
  view: 'runs',
  project: null,
  runs: [],
  runsLoaded: false,
  listFilter: '',
  selected: null,
  detail: null,
  tab: 'diff',
  attempt: 0,
  compareDiff: null,
  job: null,
  models: null,
  draft: {
    kind: 'compare',
    task: '',
    models: null,
    readonly: false,
    runTests: false,
    timeoutSec: '',
    concurrency: '',
    keepWorktrees: false,
    taskFiles: '',
    plan: null,
  },
  memory: { q: '', scope: '' },
  odds: { category: '', byCategory: false },
  context: { task: '', files: '' },
  timers: { runs: null, job: null },
}

const route = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const view = VIEWS.includes(parts[0]) ? parts[0] : 'runs'
  return { view, id: parts[1] ? decodeURIComponent(parts[1]) : undefined }
}
const go = (path) => {
  location.hash = path
}
const readonly = () => Boolean(state.project?.readonly)

const setTitle = (t) => {
  $('#pageTitle').textContent = t
  document.title = `Sidebet · ${t}${state.project ? ` · ${state.project.name}` : ''}`
}

const renderChrome = () => {
  const p = state.project
  fill(
    $('#projectLine'),
    p
      ? [
          h('b', {}, p.name),
          p.branch ? h('span', { class: 'mono' }, p.branch) : null,
          p.head ? h('span', { class: 'mono dim' }, p.head) : null,
          p.dirty ? h('span', {}, `${p.dirty} uncommitted`) : null,
          p.initialized
            ? null
            : h('a', { href: '#/settings', class: 'warning' }, 'not initialized'),
        ]
      : [],
  )
  fill(
    $('#barMeta'),
    p
      ? [
          h('span', {}, `v${p.version}`),
          h(
            'span',
            { class: `mode ${p.readonly ? 'ro' : 'rw'}`, title: 'Bound to 127.0.0.1 only' },
            p.readonly ? 'read-only' : 'local · read-write',
          ),
        ]
      : [],
  )
  $('#newBtn').hidden = readonly()
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.view === state.view)
    if (a.dataset.view === 'new') a.hidden = readonly()
  }
}

const refreshProject = async () => {
  state.project = await get('/api/project')
  renderChrome()
  const chip = $('#barChip')
  const src = `/chip.svg?variant=${encodeURIComponent(state.project.chip)}`
  if (!chip.src.endsWith(src)) chip.src = src
}

// ---------- runs: list ----------

const refreshRuns = async () => {
  state.runs = await get('/api/runs')
  state.runsLoaded = true
  const running = state.runs.some((d) => d.run.status === 'running')
  $('#live').classList.toggle('on', running)
  $('#liveText').textContent = running ? 'live' : 'idle'
  return running
}

const renderList = () => {
  const list = $('#list')
  if (!list) return
  const shown = state.runs.filter((d) => !state.listFilter || d.run.status === state.listFilter)
  const head = h(
    'div',
    { class: 'list-head' },
    h('span', { class: 'dim' }, `${shown.length} of ${state.runs.length}`),
    h('span', { class: 'spacer' }),
    h(
      'select',
      {
        onchange: (e) => {
          state.listFilter = e.target.value
          renderList()
        },
      },
      ...['', 'running', 'completed', 'partial', 'failed', 'cancelled'].map((s) =>
        h('option', { value: s, selected: state.listFilter === s }, s || 'all statuses'),
      ),
    ),
  )
  const rows = shown.map((d) => {
    const r = d.run
    return h(
      'a',
      {
        class: `run${state.selected === r.id ? ' selected' : ''}`,
        href: `#/runs/${encodeURIComponent(r.id)}`,
      },
      h(
        'div',
        { class: 'top' },
        r.status === 'running' ? h('span', { class: 'spin' }) : null,
        pill(r.status),
        h('span', {}, r.kind),
        h('span', { class: 'dim mono' }, r.id),
        h('span', { class: 'spacer' }),
        h('span', {}, ago(r.createdAt)),
      ),
      h('div', { class: 'task' }, r.task),
      h(
        'div',
        { class: 'lanes' },
        ...d.attempts.map((a, i) =>
          h('span', { class: `lane${i}` }, `${a.attempt.label} ${a.attempt.model}`),
        ),
      ),
    )
  })
  fill(list, [
    head,
    ...rows,
    state.runs.length
      ? null
      : h(
          'div',
          { class: 'empty' },
          'No runs yet. ',
          readonly() ? 'Try: sidebet compare "<task>"' : h('a', { href: '#/new' }, 'Start one.'),
        ),
  ])
}

// ---------- runs: live job panel ----------

const stopJobWatch = () => {
  clearInterval(state.timers.job)
  state.timers.job = null
}

const watchJob = (jobId) => {
  stopJobWatch()
  const tick = async () => {
    let j
    try {
      j = await get(`/api/jobs/${encodeURIComponent(jobId)}`)
    } catch (e) {
      stopJobWatch()
      return fail(e)
    }
    state.job = j
    const box = $('#job')
    if (box && state.detail && j.runId === state.detail.run.id) box.replaceWith(renderJobPanel(j))
    if (j.status !== 'running') {
      stopJobWatch()
      toast(
        j.status === 'failed'
          ? `Job failed: ${j.error ?? 'unknown error'}`
          : `${j.kind === 'compare' ? 'Compare' : 'Run'} ${j.runStatus ?? 'finished'}`,
        j.status === 'failed' || j.runStatus === 'failed' ? 'err' : 'ok',
      )
      await refreshRuns()
      renderList()
      if (j.runId && state.view === 'runs') await select(j.runId)
    }
  }
  state.timers.job = setInterval(tick, 1000)
  tick()
}

const renderJobPanel = (j) => {
  const running = j.status === 'running'
  const pendingApprovals = j.approvals.filter((a) => !a.decision)
  const cards = j.attempts.map((g, i) => {
    const total = g.input + g.output + g.cacheRead
    return h(
      'div',
      { class: `card lane b-lane${i}` },
      h(
        'div',
        { class: 'title' },
        h('b', { class: `lane${i}` }, `${g.label}  ${g.model}`),
        h(
          'span',
          {},
          g.status === 'running' ? h('span', { class: 'spin' }) : null,
          pill(g.status),
          ' ',
          g.startedAt ? since(g.startedAt, g.endedAt) : h('span', { class: 'dim' }, 'waiting'),
        ),
      ),
      h(
        'div',
        { class: 'grid' },
        h('span', {}, 'tokens'),
        h(
          'span',
          {},
          compact(total),
          ' ',
          h('span', { class: 'dim' }, `↑${compact(g.input + g.cacheRead)} ↓${compact(g.output)}`),
        ),
        h('span', {}, 'turns'),
        h('span', {}, String(g.turns)),
        h('span', {}, 'tools'),
        h(
          'span',
          {},
          String(g.tools),
          g.denied ? h('span', { class: 'error' }, `  ${g.denied} blocked`) : null,
          g.errors ? h('span', { class: 'warning' }, `  ${g.errors} failed`) : null,
        ),
        h('span', {}, 'cost'),
        h('span', {}, g.cost === undefined ? h('span', { class: 'dim' }, 'n/a') : fmtCost(g.cost)),
        g.firstEditMs !== undefined ? h('span', {}, 'first edit') : null,
        g.firstEditMs !== undefined ? h('span', {}, fmtDur(g.firstEditMs)) : null,
      ),
      h(
        'div',
        { class: `cur ${g.error ? 'error' : ''}`, title: g.error || g.current },
        g.error || (g.status === 'completed' ? 'done' : g.current),
      ),
      j.kind === 'run' && g.text ? h('pre', { class: 'block' }, g.text) : null,
    )
  })
  const log = h(
    'div',
    { class: 'log' },
    ...j.events.slice(-60).map((e) =>
      h(
        'div',
        {},
        h('span', { class: 'dim mono' }, new Date(e.at).toLocaleTimeString()),
        h('span', { class: 'mono accent' }, e.label ?? ''),
        h(
          'span',
          {
            class:
              e.kind === 'blocked' || e.kind === 'tool-error'
                ? 'error'
                : e.kind === 'warn'
                  ? 'warning'
                  : e.kind === 'tool'
                    ? ''
                    : 'muted',
          },
          e.text,
        ),
      ),
    ),
  )
  queueMicrotask(() => {
    log.scrollTop = log.scrollHeight
  })
  return h(
    'div',
    { class: 'job', id: 'job' },
    h(
      'div',
      { class: 'head' },
      running ? h('span', { class: 'spin' }) : null,
      h('b', {}, running ? (j.cancelling ? 'Cancelling…' : 'Live') : `Job ${j.status}`),
      h('span', { class: 'dim' }, since(j.startedAt, j.endedAt)),
      h('span', { class: 'spacer' }),
      running && !j.cancelling
        ? h(
            'button',
            {
              class: 'danger sm',
              onclick: async () => {
                try {
                  await post(`/api/jobs/${j.id}/cancel`)
                  toast('Cancelling: stopping agents and keeping partial work', 'warn')
                } catch (e) {
                  fail(e)
                }
              },
            },
            'Cancel',
          )
        : null,
    ),
    ...pendingApprovals.map((a) =>
      h(
        'div',
        { class: 'approval' },
        h('b', {}, 'Approval needed: '),
        h('span', { class: 'mono' }, `${a.tool} ${a.summary}`),
        h('div', { class: 'caveat' }, a.reason),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'primary sm',
              onclick: () =>
                post(`/api/jobs/${j.id}/approvals/${a.id}`, { allow: true }).catch(fail),
            },
            'Allow',
          ),
          h(
            'button',
            {
              class: 'danger sm',
              onclick: () =>
                post(`/api/jobs/${j.id}/approvals/${a.id}`, { allow: false }).catch(fail),
            },
            'Deny',
          ),
          h('span', { class: 'dim' }, 'Unanswered approvals are denied after 10 minutes.'),
        ),
      ),
    ),
    h('div', { class: 'cards' }, ...cards),
    j.events.length ? log : null,
  )
}

// ---------- runs: detail ----------

const select = async (id) => {
  state.selected = id
  state.attempt = 0
  state.compareDiff = null
  renderList()
  const root = $('#detail')
  if (!root) return
  try {
    state.detail = await get(`/api/runs/${encodeURIComponent(id)}`)
  } catch (e) {
    root.replaceChildren(h('div', { class: 'empty error' }, e.message))
    return
  }
  const jobId = state.detail.jobId
  if (jobId && (!state.job || state.job.id !== jobId)) {
    state.job = await get(`/api/jobs/${jobId}`).catch(() => null)
  }
  if (state.job?.id === jobId && state.job?.status === 'running' && !state.timers.job)
    watchJob(jobId)
  renderDetail()
}

const METRICS = [
  ['Status', (a) => a.attempt.status],
  ['Total time', (a) => fmtDur(a.attempt.durationMs), (a) => a.attempt.durationMs, 'lower'],
  ['Agent time', (a) => fmtDur(a.usage?.agentDurationMs), (a) => a.usage?.agentDurationMs, 'lower'],
  [
    'Time to first token',
    (a) => fmtDur(a.usage?.timeToFirstTokenMs),
    (a) => a.usage?.timeToFirstTokenMs,
    'lower',
  ],
  [
    'Time to first edit',
    (a) => fmtDur(a.usage?.timeToFirstEditMs),
    (a) => a.usage?.timeToFirstEditMs,
    'lower',
  ],
  ['Turns', (a) => (a.usage ? String(a.usage.turns) : '–')],
  [
    'Tool calls',
    (a) => {
      if (!a.usage) return '–'
      const by = Object.entries(a.usage.toolCallsByTool || {})
        .sort((x, y) => y[1] - x[1])
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')
      return `${a.usage.toolCalls}${by ? ` (${by})` : ''}`
    },
  ],
  [
    'Tool errors / blocked',
    (a) => (a.usage ? `${a.usage.toolErrors} / ${a.usage.toolsDenied}` : '–'),
  ],
  ['Input tokens', (a) => fmtTok(a.usage?.inputTokens), (a) => a.usage?.inputTokens, 'lower'],
  ['Output tokens', (a) => fmtTok(a.usage?.outputTokens), (a) => a.usage?.outputTokens, 'lower'],
  [
    'Cache read / write',
    (a) =>
      a.usage ? `${fmtTok(a.usage.cacheReadTokens)} / ${fmtTok(a.usage.cacheWriteTokens)}` : '–',
  ],
  ['Total tokens', (a) => fmtTok(a.usage?.totalTokens), (a) => a.usage?.totalTokens, 'lower'],
  ['Cost', (a) => fmtCost(a.usage?.costUsd), (a) => a.usage?.costUsd, 'lower'],
  ['Files changed', (a) => String(a.attempt.changedFiles.length)],
  [
    'Lines +/−',
    (a) =>
      a.attempt.linesAdded === undefined || a.attempt.linesAdded === null
        ? '–'
        : `+${a.attempt.linesAdded} / −${a.attempt.linesRemoved ?? 0}`,
  ],
  ['Tests', (a) => testText(a)],
  ['Test time', (a) => fmtDur(a.tests?.find((t) => t.status !== 'skipped')?.durationMs)],
]

const metricsTable = (attempts) => {
  const table = h(
    'table',
    {},
    h(
      'tr',
      {},
      h('th'),
      ...attempts.map((a, i) =>
        h('th', { class: `lane${i}` }, `${a.attempt.label}  ${modelRef(a.attempt)}`),
      ),
    ),
  )
  for (const [label, value, of, prefer] of METRICS) {
    let best = -1
    if (of && attempts.length > 1) {
      const nums = attempts.map(of)
      if (nums.every((n) => n !== undefined && n !== null) && new Set(nums).size > 1)
        best = nums.indexOf(prefer === 'lower' ? Math.min(...nums) : Math.max(...nums))
    }
    table.append(
      h(
        'tr',
        {},
        h('td', { class: 'dim' }, label),
        ...attempts.map((a, i) => h('td', { class: i === best ? 'best' : '' }, value(a))),
      ),
    )
  }
  return table
}

const parseDiff = (patch) => {
  const files = []
  let file = null
  let oldN = 0
  let newN = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      file = { name: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), lines: [], add: 0, del: 0 }
      files.push(file)
      continue
    }
    if (!file) continue
    if (
      /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(
        line,
      )
    )
      continue
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
      oldN = Number(m?.[1] ?? 0)
      newN = Number(m?.[2] ?? 0)
      file.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', n: newN++, text: line.slice(1) })
      file.add++
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', o: oldN++, text: line.slice(1) })
      file.del++
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else file.lines.push({ kind: 'ctx', o: oldN++, n: newN++, text: line.slice(1) })
  }
  return files
}

const renderDiff = (patch) => {
  if (!patch?.trim()) return h('div', { class: 'muted' }, 'No changes.')
  return h(
    'div',
    {},
    ...parseDiff(patch).map((f) => {
      const pre = h('pre', {})
      for (const l of f.lines) {
        if (l.kind === 'hunk') pre.append(h('div', { class: 'hunk' }, l.text))
        else
          pre.append(
            h(
              'div',
              { class: `l ${l.kind}` },
              h('span', {}, l.o ?? ''),
              h('span', {}, l.n ?? ''),
              h('span', {}, l.text),
            ),
          )
      }
      return h(
        'div',
        { class: 'diff' },
        h(
          'div',
          {
            class: 'file',
            onclick: () => {
              pre.hidden = !pre.hidden
            },
          },
          h('span', { class: 'mono' }, f.name),
          h(
            'span',
            {},
            h('span', { class: 'success' }, `+${f.add}`),
            ' ',
            h('span', { class: 'error' }, `−${f.del}`),
          ),
        ),
        pre,
      )
    }),
  )
}

const labelOf = (d, attemptId) => d.attempts.find((a) => a.attempt.id === attemptId)?.attempt.label

const refreshDetail = async () => {
  await refreshRuns()
  renderList()
  if (state.selected) await select(state.selected)
}

const doBet = async (runId, pick) => {
  try {
    await post(`/api/runs/${runId}/bet`, { pick })
    toast(`Called ${pick}. Resolved when you record a preference; tallied in Odds.`, 'ok')
    await refreshDetail()
  } catch (e) {
    fail(e)
  }
}

const doReview = async (runId, body) => {
  try {
    await post(`/api/runs/${runId}/review`, body)
    const bet = state.detail?.bets?.at(-1)
    const called =
      bet && body.preferred
        ? bet.pick === body.preferred
          ? ' · matched your call'
          : ` · your call was ${bet.pick}`
        : ''
    toast(`Review recorded${called}`, 'ok')
    await refreshDetail()
  } catch (e) {
    fail(e)
  }
}

const applyFlow = async (d, label) => {
  const a = d.attempts.find((x) => x.attempt.label === label)
  const incomplete = a && a.attempt.status !== 'completed'
  let allowIncomplete = false
  const body = h('div', {}, h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Checking…'))
  const load = async () => {
    try {
      const p = await get(
        `/api/runs/${d.run.id}/apply/${encodeURIComponent(label)}${allowIncomplete ? '?allowIncomplete=1' : ''}`,
      )
      fill(body, [
        h(
          'p',
          { class: 'caveat' },
          `Apply ${p.label} (${p.model}) to your working tree. ${p.files.length} file(s), from the ${p.source === 'ref' ? 'kept Git ref' : 'stored diff'}.`,
        ),
        h(
          'ul',
          { class: 'checks' },
          ...p.files.map((f) =>
            h(
              'li',
              {},
              h(
                'span',
                { class: `mark ${p.locallyModified.includes(f) ? 'warning' : 'dim'}` },
                p.locallyModified.includes(f) ? 'M*' : '·',
              ),
              h('span', { class: 'mono' }, f),
            ),
          ),
        ),
        p.locallyModified.length
          ? h(
              'p',
              { class: 'caveat warning' },
              `M* = you have local edits in ${p.locallyModified.length} of these files; the patch layers on top without discarding them.`,
            )
          : null,
        p.applies
          ? h(
              'p',
              { class: 'caveat' },
              'Applies to the working tree only (no commit, index untouched). A backup ref of your current tree is saved first, and the command to undo is shown afterwards.',
            )
          : h(
              'div',
              { class: 'note err' },
              'Cannot apply cleanly. Nothing will be changed.',
              h('pre', { class: 'block' }, p.conflict ?? ''),
            ),
      ])
      return p.applies
    } catch (e) {
      body.replaceChildren(
        h(
          'div',
          { class: 'note err' },
          e.message,
          e.data?.hint ? h('div', { class: 'caveat' }, e.data.hint) : null,
        ),
      )
      return false
    }
  }
  let applies = false
  const wrapper = h('div', {})
  if (incomplete) {
    wrapper.append(
      h(
        'label',
        { class: 'check', style: 'margin-bottom:10px' },
        h('input', {
          type: 'checkbox',
          onchange: async (e) => {
            allowIncomplete = e.target.checked
            applies = await load()
          },
        }),
        `Attempt ${label} ended as "${a.attempt.status}"; apply its partial work anyway`,
      ),
    )
  }
  wrapper.append(body)
  const pending = load().then((ok) => {
    applies = ok
  })
  const result = await modal({
    title: `Apply ${label}`,
    body: wrapper,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Apply to working tree',
        primary: true,
        run: async () => {
          await pending
          if (!applies) return false
          return post(`/api/runs/${d.run.id}/apply`, { label, allowIncomplete })
        },
      },
    ],
  })
  if (result?.application) {
    const app = result.application
    toast(
      `Applied ${app.files.length} file(s). Undo: git checkout ${app.backupRef} -- <files>`,
      'ok',
    )
    await refreshDetail()
    await refreshProject()
  }
}

const rerunFlow = async (d) => {
  let context = 'original'
  let readonlyRun = d.run.readonly
  const models = h('input', {
    type: 'text',
    value: [...new Set(d.attempts.map((a) => modelRef(a.attempt)))].join(','),
  })
  const preview = h('div', {})
  const body = h(
    'div',
    {},
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lbl' }, 'Context'),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'rctx',
          checked: true,
          onchange: () => {
            context = 'original'
          },
        }),
        'Original snapshot: the rules, memory and docs exactly as recorded for this run (files on disk are ignored for context)',
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'rctx',
          onchange: () => {
            context = 'current'
          },
        }),
        'Current project: rules, memory and docs assembled fresh now (a different input)',
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lbl' }, 'Models (comma separated; aliases allowed)'),
      models,
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: readonlyRun,
        onchange: (e) => {
          readonlyRun = e.target.checked
        },
      }),
      'Read-only',
    ),
    h(
      'p',
      { class: 'caveat' },
      'A rerun repeats the inputs, not the outputs: model behaviour, provider versions and dependencies may differ.',
    ),
    preview,
  )
  const payload = () => ({ context, models: models.value, readonly: readonlyRun })
  const r = await modal({
    title: `Rerun ${d.run.id}`,
    body,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Preview',
        run: async () => {
          const p = await post(`/api/runs/${d.run.id}/rerun`, { ...payload(), dryRun: true })
          preview.replaceChildren(
            h('h3', { style: 'margin-top:12px' }, 'What will happen'),
            ...p.notes.map((n) => h('div', { class: 'caveat' }, `• ${n}`)),
            renderPlan(p.plan),
          )
          return false
        },
      },
      {
        label: 'Start rerun',
        primary: true,
        run: () => post(`/api/runs/${d.run.id}/rerun`, payload()),
      },
    ],
  })
  if (r?.job) {
    toast('Rerun started', 'ok')
    state.job = r.job
    state.runsLoaded = false
    go(`#/runs/${encodeURIComponent(r.job.runId ?? '')}`)
    watchJob(r.job.id)
    poll()
  }
}

const suggestFlow = async (runId) => {
  let data
  try {
    data = await get(`/api/runs/${runId}/memory-suggestions`)
  } catch (e) {
    return fail(e)
  }
  if (!data.candidates.length)
    return toast(
      'No memory candidates found in this run. Suggestions are heuristic; nothing is saved automatically.',
    )
  const chosen = new Set()
  let global = false
  const r = await modal({
    title: `Memory candidates from ${runId}`,
    body: h(
      'div',
      {},
      h(
        'p',
        { class: 'caveat' },
        'Heuristic picks from the agent summaries. Review before saving; nothing is ever saved without you.',
      ),
      ...data.candidates.map((c, i) =>
        h(
          'label',
          { class: 'check', style: 'display:flex;margin:8px 0;align-items:flex-start' },
          h('input', {
            type: 'checkbox',
            onchange: (e) => (e.target.checked ? chosen.add(i) : chosen.delete(i)),
          }),
          c,
        ),
      ),
      h(
        'label',
        { class: 'check', style: 'margin-top:10px' },
        h('input', {
          type: 'checkbox',
          onchange: (e) => {
            global = e.target.checked
          },
        }),
        'Save as global memory (all projects)',
      ),
    ),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save selected',
        primary: true,
        run: async () => {
          if (!chosen.size) return false
          for (const i of chosen)
            await post('/api/memory', { text: data.candidates[i], global, source: 'suggestion' })
          return chosen.size
        },
      },
    ],
  })
  if (r) toast(`Saved ${r} of ${data.candidates.length} as memory`, 'ok')
}

const checkoutFlow = async (runId, label) => {
  try {
    const r = await post(`/api/runs/${runId}/checkout`, { label })
    await modal({
      title: `Checked out ${r.label}`,
      body: h(
        'div',
        {},
        h('p', {}, 'A worktree with the attempt result is at:'),
        h('pre', { class: 'block' }, r.path),
        h(
          'p',
          { class: 'caveat' },
          'Remove it later from Doctor → Clean worktrees, or with git worktree remove.',
        ),
      ),
    })
  } catch (e) {
    fail(e)
  }
}

const renderActions = (d) => {
  if (readonly() || d.run.status === 'running') return null
  const r = d.run
  const isCompare = r.kind === 'compare'
  const lastReview = d.reviews.at(-1)
  const preferredId = [...d.reviews].reverse().find((x) => x.preferredAttemptId)?.preferredAttemptId
  const bet = d.bets.at(-1)
  const cards = []
  if (isCompare && !bet && !preferredId && d.attempts.length > 1) {
    cards.push(
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Your call'),
        h(
          'p',
          { class: 'caveat' },
          'Before reading the diffs: which result do you expect to prefer? It measures your prediction, not the models, and changes nothing about the run.',
        ),
        h(
          'div',
          { class: 'actions' },
          ...d.attempts.map((a, i) =>
            h(
              'button',
              { onclick: () => doBet(r.id, a.attempt.label) },
              h('span', { class: `lane${i}` }, a.attempt.label),
              ` ${a.attempt.model}`,
            ),
          ),
        ),
      ),
    )
  }
  let preferred = labelOf(d, preferredId)
  let accepted = lastReview ? lastReview.accepted : true
  const reason = h('input', {
    type: 'text',
    placeholder: 'Reason (optional)',
    style: 'max-width:280px',
  })
  const notes = h('input', {
    type: 'text',
    placeholder: 'Notes (optional)',
    style: 'max-width:280px',
  })
  const segBtns = ['Accept', 'Reject'].map((t) =>
    h(
      'button',
      {
        class: (t === 'Accept') === accepted ? 'active' : '',
        onclick: () => {
          accepted = t === 'Accept'
          for (const b of segBtns)
            b.classList.toggle('active', (b.textContent === 'Accept') === accepted)
        },
      },
      t,
    ),
  )
  cards.push(
    h(
      'div',
      { class: 'card' },
      h('h3', {}, lastReview ? 'Review again' : 'Review'),
      isCompare
        ? h(
            'div',
            { class: 'row', style: 'margin-bottom:8px' },
            h('span', { class: 'dim' }, 'Preferred:'),
            ...d.attempts.map((a, i) =>
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'radio',
                  name: 'pref',
                  checked: preferred === a.attempt.label,
                  onchange: () => {
                    preferred = a.attempt.label
                  },
                }),
                h('span', { class: `lane${i}` }, a.attempt.label),
                h('span', { class: 'dim' }, a.attempt.model),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'seg' }, ...segBtns),
        reason,
        notes,
        h(
          'button',
          {
            class: 'primary',
            onclick: () =>
              doReview(r.id, { preferred, accepted, reason: reason.value, notes: notes.value }),
          },
          'Record review',
        ),
      ),
      lastReview
        ? h('p', { class: 'caveat' }, 'A new entry is added; earlier reviews stay in the record.')
        : null,
    ),
  )
  const more = h('div', { class: 'actions' })
  if (isCompare)
    for (const [i, a] of d.attempts.entries())
      more.append(
        h(
          'button',
          {
            disabled: !a.attempt.changedFiles.length,
            title: a.attempt.changedFiles.length ? '' : 'made no changes',
            onclick: () => applyFlow(d, a.attempt.label),
          },
          'Apply ',
          h('span', { class: `lane${i}` }, a.attempt.label),
        ),
      )
  for (const [i, a] of d.attempts.entries())
    if (a.attempt.resultCommit)
      more.append(
        h(
          'button',
          { onclick: () => checkoutFlow(r.id, a.attempt.label) },
          'Check out ',
          h('span', { class: `lane${i}` }, a.attempt.label),
        ),
      )
  more.append(
    h('button', { onclick: () => rerunFlow(d) }, 'Rerun…'),
    h('button', { onclick: () => suggestFlow(r.id) }, 'Suggest memories…'),
  )
  cards.push(
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Apply, check out, rerun'),
      more,
      isCompare
        ? h(
            'p',
            { class: 'caveat' },
            'Apply previews the files and keeps a backup ref; it never commits. Check out opens the attempt in its own worktree.',
          )
        : h(
            'p',
            { class: 'caveat' },
            'This run edited the working tree directly, so there is nothing to apply; its diff is under the diff tab.',
          ),
    ),
  )
  return h('div', { class: 'cards', style: 'margin-top:14px' }, ...cards)
}

const renderDetail = () => {
  const d = state.detail
  const root = $('#detail')
  if (!d || !root) return
  const r = d.run
  setTitle(r.task.length > 80 ? `${r.task.slice(0, 79)}…` : r.task)
  const preferredId = [...d.reviews].reverse().find((x) => x.preferredAttemptId)?.preferredAttemptId
  const bet = d.bets.at(-1)
  const kids = []
  kids.push(h('h1', { class: 'pt' }, r.task))
  kids.push(
    h(
      'div',
      { class: 'meta' },
      h('span', {}, pill(r.status)),
      h('span', {}, h('b', {}, r.kind)),
      h('span', { class: 'mono' }, r.id),
      h('span', {}, 'created ', h('b', {}, new Date(r.createdAt).toLocaleString())),
      r.completedAt
        ? h(
            'span',
            {},
            'took ',
            h('b', {}, fmtDur(new Date(r.completedAt) - new Date(r.createdAt))),
          )
        : null,
      r.readonly ? h('span', { class: 'warning' }, 'read-only') : null,
      r.baseCommit
        ? h('span', {}, 'base ', h('b', { class: 'mono' }, r.baseCommit.slice(0, 10)))
        : null,
      h('span', {}, 'policy ', h('b', { class: 'mono' }, r.policyVersion)),
      h('span', {}, 'config ', h('b', { class: 'mono' }, r.configVersion)),
      r.contextMode === 'original'
        ? h('span', { class: 'info' }, 'replayed original context')
        : null,
      r.parentRunId
        ? h(
            'span',
            {},
            'rerun of ',
            h('a', { class: 'mono', href: `#/runs/${r.parentRunId}` }, r.parentRunId),
          )
        : null,
    ),
  )
  if (
    state.job &&
    state.job.runId === r.id &&
    (state.job.status === 'running' || r.status === 'running')
  )
    kids.push(renderJobPanel(state.job))
  else if (r.status === 'running')
    kids.push(
      h(
        'div',
        { class: 'note warn', style: 'margin-top:12px' },
        'This run is in progress in a terminal session. The page polls for updates.',
      ),
    )

  kids.push(h('h2', {}, 'Attempts'))
  kids.push(
    h(
      'div',
      { class: 'cards' },
      ...d.attempts.map((a, i) =>
        h(
          'div',
          { class: `card lane b-lane${i}` },
          h(
            'div',
            { class: 'title' },
            h('b', { class: `lane${i}` }, `${a.attempt.label}  ${modelRef(a.attempt)}`),
            h(
              'span',
              {},
              pill(a.attempt.status),
              preferredId === a.attempt.id ? h('span', { class: 'gold' }, ' ★ preferred') : null,
            ),
          ),
          h(
            'div',
            { class: 'grid' },
            h('span', {}, 'files'),
            h(
              'span',
              {},
              `${a.attempt.changedFiles.length}${a.attempt.linesAdded !== undefined && a.attempt.linesAdded !== null ? `  (+${a.attempt.linesAdded} / −${a.attempt.linesRemoved ?? 0})` : ''}`,
            ),
            h('span', {}, 'tests'),
            h(
              'span',
              {
                class:
                  a.tests?.[0]?.status === 'passed'
                    ? 'success'
                    : a.tests?.[0]?.status === 'failed'
                      ? 'error'
                      : 'muted',
              },
              testText(a),
            ),
            h('span', {}, 'time'),
            h('span', {}, fmtDur(a.attempt.durationMs)),
            h('span', {}, 'tokens'),
            h(
              'span',
              {},
              a.usage ? `${fmtTok(a.usage.totalTokens)}  ` : '–',
              a.usage
                ? h(
                    'span',
                    { class: 'dim' },
                    `↑${fmtTok(a.usage.inputTokens + a.usage.cacheReadTokens)} ↓${fmtTok(a.usage.outputTokens)}`,
                  )
                : null,
            ),
            h('span', {}, 'cost'),
            h('span', {}, fmtCost(a.usage?.costUsd)),
            a.attempt.error ? h('span', {}, 'error') : null,
            a.attempt.error ? h('span', { class: 'error' }, a.attempt.error) : null,
          ),
        ),
      ),
    ),
  )
  const actions = renderActions(d)
  if (actions) kids.push(h('h2', {}, 'Actions'), actions)
  if (bet || d.reviews.length || d.applications.length) {
    kids.push(h('h2', {}, 'Record'))
    const box = h('div', { class: 'meta' })
    if (bet) {
      const hit = preferredId ? labelOf(d, preferredId) === bet.pick : null
      box.append(
        h(
          'span',
          {},
          'your call ',
          h('b', {}, bet.pick),
          ' ',
          hit === null
            ? h('span', { class: 'dim' }, '(unresolved: record a preference)')
            : hit
              ? h('span', { class: 'gold' }, '◉ matched')
              : h('span', { class: 'dim' }, '◎ did not match'),
        ),
      )
    }
    for (const rv of d.reviews)
      box.append(
        h(
          'span',
          {},
          rv.accepted
            ? h('b', { class: 'success' }, 'accepted')
            : h('b', { class: 'warning' }, 'not accepted'),
          rv.preferredAttemptId ? ` · preferred ${labelOf(d, rv.preferredAttemptId) ?? '?'}` : '',
          rv.reason ? ` · ${rv.reason}` : '',
          rv.notes ? ` · ${rv.notes}` : '',
          h('span', { class: 'dim' }, ` · ${ago(rv.createdAt)}`),
        ),
      )
    for (const ap of d.applications)
      box.append(
        h(
          'span',
          { class: 'dim' },
          `applied ${ap.resultRef} · backup ${ap.backupRef} · ${ago(ap.createdAt)}`,
        ),
      )
    kids.push(box)
  }
  kids.push(h('h2', {}, 'Metrics'))
  kids.push(metricsTable(d.attempts))
  kids.push(
    h(
      'div',
      { class: 'caveat' },
      '◂ marks the better value for that single metric; nothing is combined into a score. Cost is only what the runtime reported.',
    ),
  )

  const tabs = ['diff', 'summary', 'tools', 'tests', 'context']
  const canCompare = d.attempts.length === 2 && d.attempts.every((a) => a.attempt.resultCommit)
  kids.push(
    h(
      'div',
      { class: 'tabs' },
      ...d.attempts.map((a, i) =>
        h(
          'button',
          {
            class: state.attempt === i && state.tab !== 'ab' ? 'active' : '',
            onclick: () => {
              state.attempt = i
              if (state.tab === 'ab') state.tab = 'diff'
              renderDetail()
            },
          },
          h('span', { class: `lane${i}` }, a.attempt.label),
          ` ${a.attempt.model}`,
        ),
      ),
      h('span', { style: 'width:12px' }),
      ...tabs.map((t) =>
        h(
          'button',
          {
            class: state.tab === t ? 'active' : '',
            onclick: () => {
              state.tab = t
              renderDetail()
            },
          },
          t,
        ),
      ),
      canCompare
        ? h(
            'button',
            {
              class: state.tab === 'ab' ? 'active' : '',
              onclick: () => {
                state.tab = 'ab'
                renderDetail()
                loadCompareDiff()
              },
            },
            'A → B',
          )
        : null,
    ),
  )
  const a = d.attempts[state.attempt]
  if (state.tab === 'ab') {
    kids.push(
      h(
        'p',
        { class: 'caveat' },
        'The difference between the two results: what B did that A did not, as a patch from A to B.',
      ),
    )
    kids.push(
      state.compareDiff === null
        ? h('div', { class: 'muted' }, h('span', { class: 'spin' }), 'Computing…')
        : renderDiff(state.compareDiff),
    )
  } else if (a) {
    if (state.tab === 'diff') kids.push(renderDiff(a.diff?.content))
    if (state.tab === 'summary')
      kids.push(h('pre', { class: 'block' }, a.attempt.summary || '(no summary)'))
    if (state.tab === 'tools') {
      const ev = h('div', { class: 'events' })
      for (const e of a.toolEvents)
        ev.append(
          h('span', { class: 'dim mono' }, new Date(e.startedAt).toLocaleTimeString()),
          h(
            'span',
            {
              class: e.status === 'denied' ? 'error' : e.status === 'error' ? 'warning' : 'success',
            },
            e.status,
          ),
          h('span', { class: 'mono' }, `${e.tool} ${e.summary}${e.reason ? ` — ${e.reason}` : ''}`),
          h('span', { class: 'dim' }, fmtDur(e.durationMs)),
        )
      kids.push(a.toolEvents.length ? ev : h('div', { class: 'muted' }, 'No tool calls.'))
    }
    if (state.tab === 'tests') {
      const t = a.tests?.[0]
      kids.push(
        t
          ? h(
              'div',
              {},
              h(
                'div',
                { class: 'meta' },
                h('span', {}, h('b', { class: 'mono' }, t.command || '(none)')),
                h('span', {}, pill(t.status)),
                h('span', {}, 'exit ', h('b', {}, String(t.exitCode ?? '–'))),
                h('span', {}, fmtDur(t.durationMs)),
              ),
              h('pre', { class: 'block' }, t.outputTail || t.note || ''),
            )
          : h('div', { class: 'muted' }, 'Tests were not run.'),
      )
      const setup = a.logs?.find((l) => l.name === 'setup.log')
      if (setup)
        kids.push(
          h(
            'details',
            {},
            h('summary', {}, 'setup.log'),
            h('pre', { class: 'block' }, setup.content),
          ),
        )
    }
    if (state.tab === 'context') kids.push(renderSnapshot(d.snapshot, { stored: true }))
  }
  root.replaceChildren(...kids)
}

const loadCompareDiff = async () => {
  const d = state.detail
  try {
    const r = await get(`/api/runs/${d.run.id}/compare`)
    if (state.detail === d) {
      state.compareDiff = r.patch
      renderDetail()
    }
  } catch (e) {
    state.compareDiff = ''
    fail(e)
  }
}

const renderSnapshot = (s, { stored = false } = {}) => {
  if (!s) return h('div', { class: 'muted' }, 'Snapshot missing.')
  const items = h('div', { class: 'items' })
  for (const it of s.items) {
    const content = h(
      'pre',
      { class: 'block', hidden: true },
      it.content ?? '(content not retained: item was not delivered)',
    )
    items.append(
      h(
        'div',
        { class: 'it' },
        h(
          'span',
          {
            class:
              it.delivery === 'omitted' ? 'dim' : it.delivery === 'native' ? 'info' : 'success',
          },
          it.delivery,
        ),
        h('span', { class: 'dim' }, it.kind),
        h(
          'div',
          {},
          h(
            'span',
            {
              class: 'mono src',
              onclick: () => {
                content.hidden = !content.hidden
              },
              title: 'Show content',
            },
            it.source,
          ),
          ' ',
          h(
            'span',
            { class: 'dim' },
            `~${it.tokens} tokens · ${it.scope} · ${it.reason}${it.redactions ? ` · ${it.redactions} secret(s) redacted` : ''}`,
          ),
          it.content !== undefined ? content : null,
        ),
      ),
    )
  }
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'meta', style: 'margin-bottom:10px' },
      h('span', {}, stored ? 'snapshot ' : 'assembled now ', h('b', { class: 'mono' }, s.id)),
      h('span', {}, 'injected ', h('b', {}, `${fmtTok(s.injectedTokens)} tokens`)),
      h('span', {}, 'native ', h('b', {}, `${fmtTok(s.nativeTokens)} tokens`)),
      h('span', {}, 'budget ', h('b', {}, fmtTok(s.budgetTokens))),
      s.nativeContextFiles
        ? null
        : h(
            'span',
            { class: 'warning' },
            'native context files disabled (policy/secrets); redacted copies injected',
          ),
    ),
    items,
    h(
      'details',
      { style: 'margin-top:10px' },
      h('summary', {}, 'Exact text appended to the system prompt (secrets redacted)'),
      h('pre', { class: 'block' }, s.rendered || '(empty)'),
    ),
  )
}

const renderRunsView = async (id) => {
  const main = $('#main')
  if (main.dataset.view !== 'runs') {
    main.dataset.view = 'runs'
    main.className = 'split'
    main.replaceChildren(
      h('aside', { class: 'list', id: 'list' }),
      h('section', { class: 'page', id: 'detail' }, h('div', { class: 'empty' }, 'Select a run')),
    )
  }
  setTitle('Runs')
  if (!state.runsLoaded) await refreshRuns()
  renderList()
  const target = id ?? state.selected ?? state.runs[0]?.run.id
  if (target && (target !== state.selected || !state.detail)) await select(target)
  else if (state.detail) renderDetail()
  else
    $('#detail').replaceChildren(
      h(
        'div',
        { class: 'empty' },
        state.runs.length
          ? 'Select a run'
          : readonly()
            ? 'No runs yet. Try: sidebet compare "<task>"'
            : h('span', {}, 'No runs yet. ', h('a', { href: '#/new' }, 'Start one'), '.'),
      ),
    )
}

// ---------- new run ----------

const resolveRef = (spec) => {
  const ms = state.models?.models ?? []
  const found = ms.find((m) => m.ref === spec || m.alias === spec) ?? ms.find((m) => m.id === spec)
  return found?.ref
}

const renderPlan = (plan) => {
  const s = plan.snapshot
  return h(
    'div',
    { class: 'card', style: 'margin-top:12px' },
    h('h3', {}, 'Plan'),
    h(
      'div',
      { class: 'kv' },
      h('span', {}, 'kind'),
      h('span', {}, plan.kind),
      h('span', {}, 'category'),
      h('span', {}, plan.category),
      h('span', {}, 'models'),
      h(
        'span',
        {},
        h('span', { class: 'mono' }, plan.models.map((m) => `${m.provider}/${m.id}`).join(' vs ')),
        h('span', { class: 'dim' }, ` · ${plan.modelBasis}`),
      ),
      plan.rejectedModels.length ? h('span', {}, 'rejected') : null,
      plan.rejectedModels.length
        ? h(
            'span',
            { class: 'warning' },
            plan.rejectedModels.map((x) => `${x.ref}: ${x.reason}`).join('; '),
          )
        : null,
      h('span', {}, 'mode'),
      h('span', {}, plan.readonly ? 'read-only' : 'read-write'),
      h('span', {}, 'tools'),
      h('span', { class: 'mono' }, plan.tools.join(', ')),
      h('span', {}, 'tests'),
      h(
        'span',
        {},
        plan.runTests
          ? plan.testCommand
            ? h('span', { class: 'mono' }, plan.testCommand)
            : 'none configured (recorded as skipped)'
          : 'not run',
      ),
      h('span', {}, 'timeout'),
      h('span', {}, fmtDur(plan.timeoutMs)),
      plan.kind === 'compare' ? h('span', {}, 'concurrency') : null,
      plan.kind === 'compare' ? h('span', {}, String(plan.concurrency)) : null,
      h('span', {}, 'context'),
      h(
        'span',
        {},
        `${fmtTok(s.injectedTokens)} injected + ${fmtTok(s.nativeTokens)} native tokens, budget ${fmtTok(s.budgetTokens)}${plan.contextMode === 'original' ? ' (original snapshot replayed)' : ''}`,
      ),
      plan.dirtyFiles.length ? h('span', {}, 'uncommitted') : null,
      plan.dirtyFiles.length
        ? h(
            'span',
            {},
            `${plan.dirtyFiles.length} file(s)${plan.kind === 'compare' ? ' – attempts start from a snapshot that includes them (compare.uncommitted)' : ''}`,
          )
        : null,
    ),
    ...plan.warnings.map((w) => h('div', { class: 'note warn', style: 'margin-top:8px' }, w)),
    h(
      'details',
      { style: 'margin-top:10px' },
      h('summary', {}, `Context items (${s.items.length}) and the exact prompt`),
      renderSnapshot(s),
    ),
  )
}

const renderNewView = async () => {
  const main = $('#main')
  main.dataset.view = 'new'
  main.className = ''
  setTitle('New run')
  const page = h(
    'section',
    { class: 'page narrow' },
    h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Detecting models…'),
  )
  main.replaceChildren(page)
  if (readonly())
    return page.replaceChildren(
      h(
        'div',
        { class: 'note warn' },
        'This UI was started with --readonly. Restart sidebet ui without it to start runs here.',
      ),
    )
  if (!state.models) {
    try {
      state.models = await get('/api/models')
    } catch (e) {
      return page.replaceChildren(h('div', { class: 'note err' }, e.message))
    }
  }
  renderNewForm(page)
}

const renderNewForm = (page) => {
  const d = state.draft
  const m = state.models
  if (d.models === null) {
    d.models = []
    const cfg =
      d.kind === 'compare' ? m.compare : [m.default ?? m.runtime.defaultModel].filter(Boolean)
    for (const spec of cfg) {
      const ref = resolveRef(spec)
      if (ref) d.models.push(ref)
    }
  }
  const eligible = m.models.filter((x) => x.eligible)
  const render = () => renderNewForm(page)
  const task = h('textarea', {
    placeholder: 'What should the agent do? e.g. Make the search case-insensitive and add a test',
    rows: 4,
    value: d.task,
    oninput: (e) => {
      d.task = e.target.value
    },
  })
  const pickKind = (kind) => {
    d.kind = kind
    d.models = null
    d.plan = null
    render()
  }
  const seg = h(
    'div',
    { class: 'seg' },
    h(
      'button',
      { class: d.kind === 'compare' ? 'active' : '', onclick: () => pickKind('compare') },
      'Compare',
    ),
    h(
      'button',
      { class: d.kind === 'run' ? 'active' : '', onclick: () => pickKind('run') },
      'Single run',
    ),
  )
  const modelsBox = h(
    'div',
    { class: 'models' },
    ...m.models.map((x) => {
      const on = d.models.includes(x.ref)
      return h(
        'label',
        {
          class: `${on ? 'on' : ''} ${x.eligible ? '' : 'off'}`,
          title: x.eligible ? (x.name ?? x.ref) : `denied: ${x.reason}`,
        },
        h('input', {
          type: d.kind === 'run' ? 'radio' : 'checkbox',
          name: 'models',
          checked: on,
          disabled: !x.eligible,
          onchange: (e) => {
            if (d.kind === 'run') d.models = [x.ref]
            else if (e.target.checked) d.models.push(x.ref)
            else d.models = d.models.filter((ref) => ref !== x.ref)
            d.plan = null
            render()
          },
        }),
        h('span', { class: 'ref' }, x.ref),
        x.alias ? h('span', { class: 'badge' }, x.alias) : null,
        x.isDefault ? h('span', { class: 'badge' }, 'default') : null,
        x.eligible ? null : h('span', { class: 'badge error' }, 'denied'),
      )
    }),
  )
  const numField = (label, key) =>
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lbl' }, label),
      h('input', {
        type: 'number',
        min: 1,
        value: d[key],
        placeholder: 'default',
        oninput: (e) => {
          d[key] = e.target.value
        },
      }),
    )
  const check = (label, key, extra) =>
    h(
      'label',
      { class: 'check', style: 'margin-bottom:10px' },
      h('input', {
        type: 'checkbox',
        checked: d[key],
        onchange: (e) => {
          d[key] = e.target.checked
          if (extra) extra()
        },
      }),
      label,
    )
  const planBox = h('div', {}, d.plan ? renderPlan(d.plan) : null)
  const payload = () => ({
    kind: d.kind,
    task: d.task,
    models: d.models,
    readonly: d.readonly,
    runTests: d.kind === 'run' ? d.runTests : undefined,
    timeoutSec: d.timeoutSec || undefined,
    concurrency: d.kind === 'compare' ? d.concurrency || undefined : undefined,
    keepWorktrees: d.kind === 'compare' ? d.keepWorktrees : undefined,
    taskFiles: d.taskFiles
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  })
  const previewBtn = h(
    'button',
    {
      onclick: async () => {
        previewBtn.disabled = true
        try {
          const r = await post('/api/plan', payload())
          d.plan = r.plan
          planBox.replaceChildren(renderPlan(d.plan))
        } catch (e) {
          fail(e)
        } finally {
          previewBtn.disabled = false
        }
      },
    },
    'Preview plan',
  )
  const startBtn = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        startBtn.disabled = true
        try {
          const r = await post('/api/jobs', payload())
          toast(`${r.job.kind === 'compare' ? 'Compare' : 'Run'} started`, 'ok')
          state.job = r.job
          d.plan = null
          d.task = ''
          state.runsLoaded = false
          go(`#/runs/${encodeURIComponent(r.job.runId ?? '')}`)
          watchJob(r.job.id)
          poll()
        } catch (e) {
          fail(e)
        } finally {
          startBtn.disabled = false
        }
      },
    },
    d.kind === 'compare' ? 'Start compare' : 'Start run',
  )
  const rt = m.runtime
  fill(page, [
    rt.available
      ? null
      : h(
          'div',
          { class: 'note err', style: 'margin-bottom:14px' },
          `Runtime ${rt.id} is unavailable: ${rt.problems.join('; ') || 'no models with credentials'}. `,
          h('a', { href: '#/doctor' }, 'Open Doctor'),
        ),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Task'), task),
    h(
      'div',
      { class: 'row', style: 'margin-bottom:14px' },
      seg,
      h(
        'span',
        { class: 'dim' },
        d.kind === 'compare'
          ? 'Same task, several models, each in its own Git worktree. Your working tree is never touched; tests run per attempt.'
          : 'One model edits your working tree directly, with your rules and memory injected.',
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h(
        'span',
        { class: 'lbl' },
        d.kind === 'compare'
          ? `Models (${d.models.length} selected; none = Sidebet picks the default pair)`
          : 'Model (none = default)',
      ),
      eligible.length
        ? modelsBox
        : h(
            'div',
            { class: 'note warn' },
            'No eligible models. ',
            h('a', { href: '#/policy' }, 'Check policy'),
            ' or log in to a provider in Pi.',
          ),
      h(
        'span',
        { class: 'help' },
        `${eligible.length} eligible of ${m.models.length} with credentials. `,
        h(
          'a',
          {
            href: '#/new',
            onclick: async (e) => {
              e.preventDefault()
              state.models = await get('/api/models?refresh=1')
              d.models = null
              render()
            },
          },
          'Refresh',
        ),
      ),
    ),
    h(
      'details',
      {
        open: Boolean(
          d.readonly ||
            d.timeoutSec ||
            d.concurrency ||
            d.taskFiles ||
            d.runTests ||
            d.keepWorktrees,
        ),
      },
      h('summary', {}, 'Options'),
      h(
        'div',
        { class: 'grid2', style: 'margin-top:10px' },
        h(
          'div',
          {},
          check(
            'Read-only (write tools removed; the tree is verified unchanged)',
            'readonly',
            () => {
              d.plan = null
            },
          ),
          d.kind === 'run'
            ? check('Run tests afterwards', 'runTests', () => {
                d.plan = null
              })
            : null,
          d.kind === 'compare' ? check('Keep worktrees after the run', 'keepWorktrees') : null,
          numField('Timeout (seconds)', 'timeoutSec'),
          d.kind === 'compare' ? numField('Concurrency', 'concurrency') : null,
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'lbl' }, 'Extra context files (one per line, repo-relative)'),
          h('textarea', {
            rows: 4,
            value: d.taskFiles,
            placeholder: 'docs/adr/0007-search.md',
            oninput: (e) => {
              d.taskFiles = e.target.value
              d.plan = null
            },
          }),
          h(
            'span',
            { class: 'help' },
            'Included for this task only; still policy-checked and secret-redacted.',
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'actions', style: 'margin-top:14px' },
      previewBtn,
      startBtn,
      h(
        'span',
        { class: 'dim' },
        'Preview shows the plan without starting anything, like --dry-run.',
      ),
    ),
    planBox,
  ])
}

// ---------- odds ----------

const meter = (n, d) =>
  d === 0
    ? h('span', { class: 'dim' }, '–')
    : h(
        'span',
        {},
        h('span', { class: 'meter' }, h('i', { style: `width:${Math.round((n / d) * 100)}%` })),
        `${n}/${d} (${Math.round((n / d) * 100)}%)`,
      )
const pct = (n, d) => (d === 0 ? '–' : `${n}/${d} (${Math.round((n / d) * 100)}%)`)

const renderOddsView = async () => {
  const main = $('#main')
  main.dataset.view = 'odds'
  main.className = ''
  setTitle('Odds')
  const page = h('section', { class: 'page' })
  main.replaceChildren(page)
  const o = await get(`/api/odds${state.odds.category ? `?category=${state.odds.category}` : ''}`)
  const kids = [
    h(
      'div',
      { class: 'row', style: 'margin-bottom:12px' },
      h(
        'div',
        { class: 'meta' },
        h('span', {}, h('b', {}, o.generatedFromRuns), ' finished runs'),
        h('span', {}, h('b', {}, o.compareRuns), ' compare'),
        h('span', {}, h('b', {}, o.reviewedRuns), ' with a recorded preference'),
      ),
      h('span', { class: 'spacer' }),
      h(
        'select',
        {
          onchange: (e) => {
            state.odds.category = e.target.value
            renderOddsView().catch(fail)
          },
        },
        h('option', { value: '', selected: !state.odds.category }, 'all categories'),
        ...CATEGORIES.map((c) => h('option', { value: c, selected: state.odds.category === c }, c)),
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: state.odds.byCategory,
          onchange: (e) => {
            state.odds.byCategory = e.target.checked
            renderOddsView().catch(fail)
          },
        }),
        'by category',
      ),
    ),
  ]
  if (o.models.length) {
    const t = h(
      'table',
      {},
      h(
        'tr',
        {},
        ...[
          'Model',
          'Runs',
          'Tests passed (objective)',
          'Preferred (human)',
          'Accepted',
          'Median time',
          'Median tokens',
          'Median cost',
        ].map((x) => h('th', {}, x)),
      ),
    )
    for (const m of o.models)
      t.append(
        h(
          'tr',
          {},
          h('td', { class: 'mono' }, m.model),
          h('td', {}, m.attempts),
          h('td', {}, meter(m.testsPassed, m.testsRun)),
          h('td', {}, meter(m.preferred, m.appearances)),
          h('td', {}, m.reviewsPicked ? `${m.reviewsAccepted}/${m.reviewsPicked}` : '–'),
          h('td', {}, fmtDur(m.medianDurationMs)),
          h('td', {}, fmtTok(m.medianTotalTokens)),
          h(
            'td',
            {},
            m.medianCostUsd !== undefined && m.medianCostUsd !== null
              ? `${fmtCost(m.medianCostUsd)} (n=${m.costReported})`
              : '–',
          ),
        ),
      )
    kids.push(h('h2', {}, 'By model'), t)
    if (state.odds.byCategory) {
      const cats = new Set()
      for (const m of o.models) for (const c of Object.keys(m.byCategory)) cats.add(c)
      for (const c of [...cats].sort()) {
        const ct = h(
          'table',
          {},
          h('tr', {}, ...['Model', 'Runs', 'Tests passed', 'Preferred'].map((x) => h('th', {}, x))),
        )
        for (const m of o.models) {
          const x = m.byCategory[c]
          if (x)
            ct.append(
              h(
                'tr',
                {},
                h('td', { class: 'mono' }, m.model),
                h('td', {}, x.attempts),
                h('td', {}, pct(x.testsPassed, x.testsRun)),
                h('td', {}, pct(x.preferred, x.appearances)),
              ),
            )
        }
        kids.push(h('h2', {}, `Category: ${c}`), ct)
      }
    }
    if (o.headToHead.length) {
      kids.push(h('h2', {}, 'Head-to-head (same task, both attempted)'))
      for (const x of o.headToHead)
        kids.push(
          h(
            'div',
            { class: 'caveat' },
            h('span', { class: 'mono' }, `${x.a} vs ${x.b}`),
            `: ${x.runs} runs · preferred ${x.aPreferred}–${x.bPreferred}`,
            x.bothRanTests
              ? ` · tests: ${x.bothPassed} both passed, ${x.aOnlyPassed} only first, ${x.bOnlyPassed} only second, ${x.bothFailed} both failed (n=${x.bothRanTests})`
              : ' · tests: no shared results',
          ),
        )
    }
    if (o.calls?.total)
      kids.push(
        h('h2', {}, 'Your calls'),
        h(
          'div',
          { class: 'chips' },
          h(
            'span',
            {},
            ...o.calls.outcomes
              .slice(-20)
              .map((c) =>
                h('span', { class: c === 'hit' ? 'gold' : 'dim' }, c === 'hit' ? '◉' : '◎'),
              ),
          ),
          ` ${o.calls.hits}/${o.calls.total} matched your later preference`,
          o.calls.streak >= 2 ? h('span', { class: 'dim' }, ` · ${o.calls.streak} in a row`) : null,
        ),
        h(
          'div',
          { class: 'caveat' },
          'A call is a bet placed before reviewing; it measures your prediction, not the models.',
        ),
      )
  } else
    kids.push(
      h(
        'div',
        { class: 'empty' },
        'No finished runs yet',
        state.odds.category ? ` in category "${state.odds.category}"` : '',
        '.',
      ),
    )
  kids.push(
    h('h2', {}, 'Caveats'),
    ...o.caveats.map((c) => h('div', { class: 'caveat' }, `• ${c}`)),
  )
  page.replaceChildren(...kids)
}

// ---------- memory ----------

const renderMemoryView = async () => {
  const main = $('#main')
  main.dataset.view = 'memory'
  main.className = ''
  setTitle('Memory')
  const page = h('section', { class: 'page narrow' })
  main.replaceChildren(page)
  const list = h('div', {})
  let timer
  const load = async () => {
    const q = state.memory.q.trim()
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (state.memory.scope) params.set('scope', state.memory.scope)
    const all = await get(`/api/memory?${params}`)
    fill(list, [
      ...all.map((m) =>
        h(
          'div',
          { class: 'mem' },
          h(
            'div',
            { class: 'body' },
            h('div', {}, m.text),
            h(
              'div',
              { class: 'tags' },
              `${m.scope} · ${m.source} · ${ago(m.createdAt)} · `,
              h('span', { class: 'mono' }, m.id),
              m.tags.length ? ` · ${m.tags.join(', ')}` : '',
            ),
          ),
          readonly()
            ? null
            : h(
                'button',
                {
                  class: 'ghost sm danger',
                  title: 'Remove',
                  onclick: async () => {
                    const yes = await confirmModal(
                      'Remove memory',
                      h(
                        'div',
                        {},
                        h('p', {}, 'This entry will no longer be included in future runs:'),
                        h('pre', { class: 'block' }, m.text),
                      ),
                      'Remove',
                      true,
                    )
                    if (!yes) return
                    try {
                      await del(`/api/memory/${m.id}`)
                      toast('Removed', 'ok')
                      load()
                    } catch (e) {
                      fail(e)
                    }
                  },
                },
                'Remove',
              ),
        ),
      ),
      all.length
        ? null
        : h(
            'div',
            { class: 'muted', style: 'padding:14px 0' },
            q
              ? 'No matches.'
              : 'No memories yet. Add one below, or accept suggestions from a finished run.',
          ),
    ])
  }
  const search = h('input', {
    type: 'search',
    placeholder: 'Search (full-text)…',
    value: state.memory.q,
    oninput: (e) => {
      state.memory.q = e.target.value
      clearTimeout(timer)
      timer = setTimeout(() => load().catch(fail), 250)
    },
  })
  const scope = h(
    'select',
    {
      onchange: (e) => {
        state.memory.scope = e.target.value
        load().catch(fail)
      },
    },
    h('option', { value: '', selected: !state.memory.scope }, 'project + global'),
    h('option', { value: 'project', selected: state.memory.scope === 'project' }, 'project only'),
    h('option', { value: 'global', selected: state.memory.scope === 'global' }, 'global only'),
  )
  const text = h('textarea', {
    rows: 2,
    placeholder:
      'Something the agent should know next time, e.g. "Public API responses use camelCase"',
  })
  const tags = h('input', {
    type: 'text',
    placeholder: 'tags, comma separated',
    style: 'max-width:260px',
  })
  let global = false
  const addBtn = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        if (!text.value.trim()) return toast('Write the memory text first', 'warn')
        try {
          await post('/api/memory', { text: text.value, tags: tags.value, global })
          text.value = ''
          tags.value = ''
          toast(
            'Saved. It will be included in relevant future runs; rules still take precedence.',
            'ok',
          )
          load()
        } catch (e) {
          fail(e)
        }
      },
    },
    'Add memory',
  )
  const suggestBtn = h(
    'button',
    {
      onclick: async () => {
        const runs = state.runsLoaded ? state.runs : await get('/api/runs?limit=30')
        const finished = runs.filter((d) => d.run.status !== 'running')
        if (!finished.length) return toast('No finished runs to draw suggestions from.')
        let runId = finished[0].run.id
        const ok = await modal({
          title: 'Suggest memories from a run',
          body: h(
            'div',
            {},
            h(
              'p',
              { class: 'caveat' },
              'Sidebet scans the agent summaries of a run for sentences that read like conventions or gotchas.',
            ),
            h(
              'select',
              {
                onchange: (e) => {
                  runId = e.target.value
                },
                style: 'max-width:100%',
              },
              ...finished
                .slice(0, 30)
                .map((d) =>
                  h('option', { value: d.run.id }, `${d.run.id} · ${d.run.task.slice(0, 70)}`),
                ),
            ),
          ),
          actions: [
            { label: 'Cancel', value: null },
            { label: 'Find candidates', primary: true, value: true },
          ],
        })
        if (ok) await suggestFlow(runId)
        load().catch(fail)
      },
    },
    'Suggest from a run…',
  )
  fill(page, [
    h('div', { class: 'row', style: 'margin-bottom:14px' }, search, scope),
    readonly()
      ? null
      : h(
          'div',
          { class: 'card' },
          h('h3', {}, 'Add'),
          text,
          h(
            'div',
            { class: 'row', style: 'margin-top:8px' },
            tags,
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                onchange: (e) => {
                  global = e.target.checked
                },
              }),
              'global (all projects)',
            ),
            h('span', { class: 'spacer' }),
            suggestBtn,
            addBtn,
          ),
        ),
    h('h2', {}, 'Entries'),
    list,
  ])
  await load()
}

// ---------- context ----------

const renderContextView = async () => {
  const main = $('#main')
  main.dataset.view = 'context'
  main.className = ''
  setTitle('Context')
  const page = h('section', { class: 'page' })
  main.replaceChildren(page)
  const out = h(
    'div',
    {},
    h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Assembling…'),
  )
  const task = h('input', {
    type: 'text',
    placeholder: 'Task (optional: shows which memories would match)',
    value: state.context.task,
    oninput: (e) => {
      state.context.task = e.target.value
    },
  })
  const files = h('input', {
    type: 'text',
    placeholder: 'extra files, comma separated',
    value: state.context.files,
    oninput: (e) => {
      state.context.files = e.target.value
    },
  })
  const load = async () => {
    const params = new URLSearchParams()
    if (state.context.task) params.set('task', state.context.task)
    for (const f of state.context.files
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean))
      params.append('file', f)
    try {
      const s = await get(`/api/context?${params}`)
      out.replaceChildren(renderSnapshot(s))
    } catch (e) {
      out.replaceChildren(h('div', { class: 'note err' }, e.message))
    }
  }
  const form = h(
    'form',
    {
      class: 'row',
      style: 'margin-bottom:14px',
      onsubmit: (e) => {
        e.preventDefault()
        load()
      },
    },
    task,
    files,
    h('button', { class: 'primary', type: 'submit' }, 'Assemble'),
  )
  page.replaceChildren(
    h(
      'p',
      { class: 'caveat' },
      'What the agent would receive right now: rules, memory, docs and skills, each with its delivery (injected by Sidebet, loaded natively by the runtime, or omitted) and the reason. Nothing is saved.',
    ),
    form,
    out,
  )
  await load()
}

// ---------- policy ----------

const renderPolicyView = async () => {
  const main = $('#main')
  main.dataset.view = 'policy'
  main.className = ''
  setTitle('Policy')
  const page = h('section', { class: 'page' })
  main.replaceChildren(page)
  const results = h('div', {})
  const model = h('input', { type: 'text', placeholder: 'model (provider/id, alias or substring)' })
  const tool = h('input', {
    type: 'text',
    placeholder: 'tool (read, write, edit, bash…)',
    style: 'max-width:200px',
  })
  const path = h('input', { type: 'text', placeholder: 'path' })
  const command = h('input', { type: 'text', placeholder: 'bash command' })
  let ro = false
  const ask = async (e) => {
    e.preventDefault()
    const q = new URLSearchParams()
    if (model.value) q.set('model', model.value)
    if (tool.value) q.set('tool', tool.value)
    if (path.value) q.set('path', path.value)
    if (command.value) q.set('command', command.value)
    if (ro) q.set('readonly', '1')
    if (![...q.keys()].length) return
    try {
      const r = await get(`/api/policy?${q}`)
      results.replaceChildren(
        ...r.checks.map((c) =>
          h(
            'div',
            {
              class: `note ${c.allowed ? (c.needsApproval ? 'warn' : 'ok') : 'err'}`,
              style: 'margin-top:8px',
            },
            h('b', { class: 'mono' }, c.subject),
            ': ',
            c.allowed ? (c.needsApproval ? 'needs human approval' : 'allowed') : 'denied',
            h('span', { class: 'dim' }, ` – ${c.reason}`),
          ),
        ),
      )
    } catch (err) {
      fail(err)
    }
  }
  const p = await get('/api/policy')
  const pol = p.policy
  page.replaceChildren(
    h(
      'div',
      { class: 'meta', style: 'margin-bottom:12px' },
      h('span', {}, 'version ', h('b', { class: 'mono' }, p.policyVersion)),
      h(
        'span',
        {},
        p.sources.length
          ? h('span', {}, 'from ', h('b', { class: 'mono' }, p.sources.join(', ')))
          : 'built-in defaults (no config files found)',
      ),
    ),
    ...p.warnings.map((w) => h('div', { class: 'note warn', style: 'margin-bottom:8px' }, w)),
    h(
      'div',
      { class: 'grid2' },
      h(
        'div',
        {},
        h('h2', {}, 'Effective policy'),
        h(
          'div',
          { class: 'kv' },
          h('span', {}, 'Providers'),
          h('span', {}, pol.allowedProviders?.join(', ') ?? 'any'),
          h('span', {}, 'Allowed models'),
          h('span', {}, pol.allowedModels?.join(', ') ?? 'any'),
          h('span', {}, 'Denied models'),
          h('span', {}, pol.deniedModels.join(', ') || 'none'),
          h('span', {}, 'Protected paths'),
          h('span', { class: 'mono' }, pol.protectedPaths.join(', ') || 'none'),
          h('span', {}, 'Read-only'),
          h('span', {}, pol.readonly ? 'always' : 'on request'),
          h('span', {}, 'Tools'),
          h(
            'span',
            {},
            pol.tools.allow
              ? `only ${pol.tools.allow.join(', ')}`
              : `all except ${pol.tools.deny.join(', ') || 'none'}`,
          ),
          h('span', {}, 'Approval required'),
          h(
            'span',
            {},
            `${pol.approvalRequired.bash.length} bash pattern(s)${pol.approvalRequired.tools.length ? `, tools: ${pol.approvalRequired.tools.join(', ')}` : ''}`,
          ),
          h('span', {}, 'Always-denied bash'),
          h('span', { class: 'mono' }, pol.bashDeny.join(', ') || 'none'),
          h('span', {}, 'Strict'),
          h('span', {}, pol.strict ? 'yes (no bash with protected paths)' : 'no'),
        ),
        h(
          'p',
          { class: 'caveat', style: 'margin-top:10px' },
          'Policy is edited in .sidebet/config.json (and ~/.sidebet/config.json as a floor). See docs/configuration.md.',
        ),
      ),
      h(
        'div',
        {},
        h('h2', {}, 'Models'),
        p.models.length
          ? h(
              'ul',
              { class: 'checks' },
              ...p.models.map((m) =>
                h(
                  'li',
                  {},
                  h(
                    'span',
                    { class: `mark ${m.allowed ? 'success' : 'error'}` },
                    m.allowed ? '✓' : '✗',
                  ),
                  h('span', { class: 'mono' }, m.model),
                  m.allowed ? null : h('span', { class: 'dim' }, m.reason),
                ),
              ),
            )
          : h(
              'div',
              { class: 'muted' },
              p.runtimeAvailable
                ? 'No models with credentials.'
                : 'Runtime unavailable; see Doctor.',
            ),
      ),
    ),
    h('h2', {}, 'What is enforced, and how'),
    h(
      'ul',
      { class: 'checks' },
      ...p.enforcement.map((r) =>
        h(
          'li',
          {},
          pill(r.status),
          h('div', {}, h('b', {}, r.control), h('div', { class: 'caveat' }, r.how)),
        ),
      ),
    ),
    h('h2', {}, 'Ask the policy'),
    h(
      'form',
      { class: 'row', onsubmit: ask },
      model,
      tool,
      path,
      command,
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          onchange: (e) => {
            ro = e.target.checked
          },
        }),
        'as read-only',
      ),
      h('button', { class: 'primary', type: 'submit' }, 'Check'),
    ),
    results,
  )
}

// ---------- doctor ----------

const renderDoctorView = async () => {
  const main = $('#main')
  main.dataset.view = 'doctor'
  main.className = ''
  setTitle('Doctor')
  const page = h(
    'section',
    { class: 'page narrow' },
    h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Checking…'),
  )
  main.replaceChildren(page)
  const load = async () => {
    const { checks } = await get('/api/doctor')
    const fails = checks.filter((c) => c.level === 'fail').length
    fill(page, [
      h(
        'div',
        { class: 'row', style: 'margin-bottom:12px' },
        h(
          'div',
          { class: `note ${fails ? 'err' : 'ok'}`, style: 'flex:1' },
          fails ? `${fails} problem(s) found.` : 'No blocking problems.',
        ),
        h('button', { onclick: () => load().catch(fail) }, 'Re-run'),
        readonly()
          ? null
          : h(
              'button',
              {
                onclick: async () => {
                  try {
                    const r = await post('/api/clean')
                    toast(
                      r.removed.length
                        ? `Removed ${r.removed.length} worktree(s). Results stay in refs/sidebet/runs/*.`
                        : 'Nothing to clean.',
                      'ok',
                    )
                    load()
                  } catch (e) {
                    fail(e)
                  }
                },
              },
              'Clean worktrees',
            ),
      ),
      h(
        'ul',
        { class: 'checks' },
        ...checks.map((c) =>
          h(
            'li',
            {},
            h(
              'span',
              {
                class: `mark ${c.level === 'ok' ? 'success' : c.level === 'warn' ? 'warning' : 'error'}`,
              },
              c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗',
            ),
            h('div', {}, c.title, c.detail ? h('div', { class: 'caveat' }, c.detail) : null),
          ),
        ),
      ),
    ])
  }
  await load()
}

// ---------- settings ----------

const getPath = (o, path) =>
  path.split('.').reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), o)
const setPath = (o, path, value) => {
  const keys = path.split('.')
  let cur = o
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  if (value === undefined) delete cur[keys.at(-1)]
  else cur[keys.at(-1)] = value
}

const FIELDS = [
  { section: 'Project', path: 'name', label: 'Project name', type: 'text' },
  {
    section: 'Tests',
    path: 'tests.command',
    label: 'Test command',
    type: 'text',
    help: 'Run in each compare worktree after the agent finishes, and after single runs when asked.',
  },
  { section: 'Tests', path: 'tests.timeoutSec', label: 'Test timeout (seconds)', type: 'number' },
  {
    section: 'Models',
    path: 'models.default',
    label: 'Default model for single runs',
    type: 'model',
    help: 'Empty: the runtime default.',
  },
  {
    section: 'Models',
    path: 'models.compare',
    label: 'Default compare models',
    type: 'models',
    help: 'Used by compare and by dual output when no models are named.',
  },
  {
    section: 'Models',
    path: 'models.aliases',
    label: 'Aliases',
    type: 'aliases',
    help: 'Short names you can use anywhere a model is accepted.',
  },
  {
    section: 'Run',
    path: 'run.dual',
    label: 'Dual output by default (plain runs compare the default pair)',
    type: 'bool',
  },
  { section: 'Run', path: 'run.runTests', label: 'Run tests after single runs', type: 'bool' },
  { section: 'Run', path: 'run.timeoutSec', label: 'Run timeout (seconds)', type: 'number' },
  { section: 'Compare', path: 'compare.concurrency', label: 'Concurrency', type: 'number' },
  {
    section: 'Compare',
    path: 'compare.timeoutSec',
    label: 'Attempt timeout (seconds)',
    type: 'number',
  },
  {
    section: 'Compare',
    path: 'compare.uncommitted',
    label: 'Uncommitted changes',
    type: 'select',
    options: ['snapshot', 'refuse'],
    help: 'snapshot: attempts start from your working tree including uncommitted changes. refuse: stop if dirty.',
  },
  {
    section: 'Compare',
    path: 'compare.linkPaths',
    label: 'Linked paths',
    type: 'list',
    help: 'Symlinked from the repo into each worktree and excluded from diffs (shared, not copied).',
  },
  {
    section: 'Compare',
    path: 'compare.setup',
    label: 'Setup command',
    type: 'text',
    help: 'Run in each worktree before the agent starts (CI=1).',
  },
  {
    section: 'Compare',
    path: 'compare.keepWorktrees',
    label: 'Keep worktrees after compares',
    type: 'bool',
  },
  {
    section: 'Context',
    path: 'context.budgetTokens',
    label: 'Injected context budget (tokens)',
    type: 'number',
  },
  {
    section: 'Context',
    path: 'context.perItemTokens',
    label: 'Per-item limit (tokens)',
    type: 'number',
  },
  { section: 'Context', path: 'context.docs', label: 'Docs to include when present', type: 'list' },
  { section: 'Context', path: 'context.memoryLimit', label: 'Memories per run', type: 'number' },
  {
    section: 'Context',
    path: 'context.memoryIncludeAllBelow',
    label: 'Include all memories at or below',
    type: 'number',
  },
  {
    section: 'Appearance',
    path: 'ui.chip',
    label: 'Chip colour (terminal header and this page)',
    type: 'chip',
  },
]

const settingsControl = (f, raw, eff, s, modelsList, mark) => {
  const current = getPath(raw, f.path)
  const effective = getPath(eff, f.path)
  if (f.type === 'text' || f.type === 'number' || f.type === 'model')
    return h('input', {
      type: f.type === 'number' ? 'number' : 'text',
      list: f.type === 'model' ? 'model-refs' : undefined,
      value: current ?? '',
      placeholder:
        effective === undefined || effective === null ? 'not set' : `default: ${effective}`,
      oninput: (e) => {
        mark()
        const v = e.target.value
        setPath(raw, f.path, v === '' ? undefined : f.type === 'number' ? Number(v) : v)
      },
    })
  if (f.type === 'list')
    return h('input', {
      type: 'text',
      value: (current ?? []).join(', '),
      placeholder: `default: ${(effective ?? []).join(', ') || 'none'}`,
      oninput: (e) => {
        mark()
        const v = e.target.value.trim()
        setPath(
          raw,
          f.path,
          v === ''
            ? undefined
            : v
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
        )
      },
    })
  if (f.type === 'bool')
    return h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: Boolean(current ?? effective),
        onchange: (e) => {
          mark()
          setPath(raw, f.path, e.target.checked)
        },
      }),
      h(
        'span',
        { class: 'dim' },
        current === undefined ? `(default: ${effective ? 'on' : 'off'})` : '',
      ),
    )
  if (f.type === 'select')
    return h(
      'select',
      {
        onchange: (e) => {
          mark()
          setPath(raw, f.path, e.target.value || undefined)
        },
      },
      h('option', { value: '', selected: current === undefined }, `default (${effective})`),
      ...f.options.map((o) => h('option', { value: o, selected: current === o }, o)),
    )
  if (f.type === 'models') {
    const chosen = new Set(current ?? [])
    const known = (ref) => modelsList.some((m) => m.ref === ref)
    const extra = h('input', {
      type: 'text',
      placeholder: 'other refs or aliases, comma separated',
      value: [...chosen].filter((c) => !known(c)).join(', '),
    })
    const commit = () => {
      mark()
      const typed = extra.value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      const list = [...[...chosen].filter(known), ...typed]
      setPath(raw, f.path, list.length ? [...new Set(list)] : undefined)
    }
    extra.addEventListener('input', commit)
    return h(
      'div',
      {},
      modelsList.length
        ? h(
            'div',
            { class: 'models', style: 'margin-bottom:6px' },
            ...modelsList.map((m) =>
              h(
                'label',
                { class: chosen.has(m.ref) ? 'on' : '' },
                h('input', {
                  type: 'checkbox',
                  checked: chosen.has(m.ref),
                  onchange: (e) => {
                    if (e.target.checked) chosen.add(m.ref)
                    else chosen.delete(m.ref)
                    e.target.parentElement.classList.toggle('on', e.target.checked)
                    commit()
                  },
                }),
                h('span', { class: 'ref' }, m.ref),
                m.alias ? h('span', { class: 'badge' }, m.alias) : null,
              ),
            ),
          )
        : h(
            'div',
            { class: 'caveat' },
            'Model list unavailable (runtime not detected); type refs below.',
          ),
      extra,
      effective?.length ? h('div', { class: 'help' }, `Current: ${effective.join(', ')}`) : null,
    )
  }
  if (f.type === 'aliases') {
    const rows = h('div', {})
    const commit = () => {
      mark()
      const o = {}
      for (const r of rows.children) {
        const [k, v] = r.querySelectorAll('input')
        if (k.value.trim() && v.value.trim()) o[k.value.trim()] = v.value.trim()
      }
      setPath(raw, f.path, Object.keys(o).length ? o : undefined)
    }
    const addRow = (k = '', v = '') => {
      const row = h(
        'div',
        { class: 'row', style: 'margin-bottom:6px' },
        h('input', {
          type: 'text',
          value: k,
          placeholder: 'alias',
          style: 'max-width:160px',
          oninput: commit,
        }),
        h('span', { class: 'dim' }, '→'),
        h('input', {
          type: 'text',
          value: v,
          placeholder: 'provider/model',
          list: 'model-refs',
          oninput: commit,
        }),
        h(
          'button',
          {
            class: 'ghost sm',
            onclick: () => {
              row.remove()
              commit()
            },
          },
          '✕',
        ),
      )
      rows.append(row)
    }
    for (const [k, v] of Object.entries(current ?? {})) addRow(k, v)
    return h('div', {}, rows, h('button', { class: 'sm', onclick: () => addRow() }, '+ alias'))
  }
  if (f.type === 'chip') {
    const picker = h('div', { class: 'chips-pick' })
    const selected = current ?? effective
    for (const name of [...s.chips, 'random'])
      picker.append(
        h(
          'button',
          {
            class: `chipbtn ${selected === name ? 'active' : ''}`,
            onclick: (e) => {
              mark()
              setPath(raw, f.path, name)
              for (const b of picker.children) b.classList.toggle('active', b === e.currentTarget)
            },
          },
          name === 'random'
            ? h('span', { style: 'font-size:28px;line-height:40px' }, '?')
            : h('img', { src: `/chip.svg?variant=${name}`, alt: name }),
          name,
        ),
      )
    return picker
  }
  return null
}

const renderSettingsView = async () => {
  const main = $('#main')
  main.dataset.view = 'settings'
  main.className = ''
  setTitle('Settings')
  const page = h(
    'section',
    { class: 'page narrow' },
    h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Loading…'),
  )
  main.replaceChildren(page)
  const draw = (s) => {
    if (!s.initialized) {
      return page.replaceChildren(
        h(
          'div',
          { class: 'card' },
          h('h3', {}, 'This project is not initialized'),
          h(
            'p',
            { class: 'caveat' },
            `Sidebet works with defaults, but a ${s.path.replace(`${s.root}/`, '')} gives the project a stable id and records the detected test command. Nothing else is written.`,
          ),
          readonly()
            ? null
            : h(
                'button',
                {
                  class: 'primary',
                  onclick: async () => {
                    try {
                      const r = await post('/api/init')
                      toast(
                        'Initialized. Commit .sidebet/config.json to share the project id.',
                        'ok',
                      )
                      await refreshProject()
                      draw(r)
                    } catch (e) {
                      fail(e)
                    }
                  },
                },
                'Initialize project',
              ),
        ),
      )
    }
    const raw = structuredClone(s.raw ?? {})
    const dirty = new Set()
    const modelsList = state.models?.models ?? []
    const datalist = h(
      'datalist',
      { id: 'model-refs' },
      ...modelsList.map((m) => h('option', { value: m.ref })),
    )
    const sections = new Map()
    for (const f of FIELDS) {
      const control = settingsControl(f, raw, s.effective, s, modelsList, () => dirty.add(f.path))
      if (!sections.has(f.section)) sections.set(f.section, [])
      sections
        .get(f.section)
        .push(
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'lbl' }, f.label),
            control,
            f.help ? h('span', { class: 'help' }, f.help) : null,
          ),
        )
    }
    const issues = h('div', {})
    const save = h(
      'button',
      {
        class: 'primary',
        disabled: readonly(),
        onclick: async () => {
          if (!dirty.size) return toast('Nothing changed.')
          save.disabled = true
          try {
            const r = await put('/api/settings', { config: raw })
            toast(`Saved ${s.path.replace(`${s.root}/`, '')}`, 'ok')
            state.models = null
            await refreshProject()
            draw(r)
          } catch (e) {
            if (e.data?.issues)
              issues.replaceChildren(
                h(
                  'div',
                  { class: 'note err' },
                  'Invalid configuration:',
                  h(
                    'ul',
                    {},
                    ...e.data.issues.map((i) =>
                      h(
                        'li',
                        {},
                        h('span', { class: 'mono' }, i.path || '(root)'),
                        `: ${i.message}`,
                      ),
                    ),
                  ),
                ),
              )
            else fail(e)
            save.disabled = false
          }
        },
      },
      'Save to .sidebet/config.json',
    )
    fill(page, [
      datalist,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'kv' },
          h('span', {}, 'project'),
          h('span', {}, h('b', {}, s.name), ' ', h('span', { class: 'mono dim' }, s.projectId)),
          h('span', {}, 'root'),
          h('span', { class: 'mono' }, s.root),
          h('span', {}, 'config files'),
          h('span', { class: 'mono' }, s.sources.join(', ') || 'none'),
          s.global ? h('span', {}, 'global layer') : null,
          s.global
            ? h(
                'span',
                { class: 'caveat' },
                `${s.globalPath} is merged underneath; policy there is a floor this page cannot lower.`,
              )
            : null,
        ),
      ),
      ...[...sections.entries()].map(([name, fields]) =>
        h('div', {}, h('h2', {}, name), h('div', { class: 'card' }, ...fields)),
      ),
      h('h2', {}, 'Policy'),
      h(
        'div',
        { class: 'card' },
        h(
          'p',
          { class: 'caveat', style: 'margin:0' },
          'Policy (allowed models, protected paths, approvals, read-only, strict) is shown and explained on the ',
          h('a', { href: '#/policy' }, 'Policy page'),
          '. Edit it in the config file; it is kept out of this form on purpose.',
        ),
      ),
      h(
        'div',
        { class: 'actions', style: 'margin-top:16px' },
        save,
        h(
          'span',
          { class: 'dim' },
          'Only fields you change are written. Clear a field to fall back to the default.',
        ),
      ),
      issues,
    ])
  }
  try {
    if (!state.models) state.models = await get('/api/models').catch(() => null)
    draw(await get('/api/settings'))
  } catch (e) {
    page.replaceChildren(h('div', { class: 'note err' }, e.message))
  }
}

// ---------- routing, polling, clock ----------

const render = async () => {
  const { view, id } = route()
  state.view = view
  renderChrome()
  if (view !== 'runs') $('#main').className = ''
  try {
    if (view === 'runs') await renderRunsView(id)
    else if (view === 'new') await renderNewView()
    else if (view === 'odds') await renderOddsView()
    else if (view === 'memory') await renderMemoryView()
    else if (view === 'context') await renderContextView()
    else if (view === 'policy') await renderPolicyView()
    else if (view === 'doctor') await renderDoctorView()
    else if (view === 'settings') await renderSettingsView()
  } catch (e) {
    $('#main').replaceChildren(
      h(
        'section',
        { class: 'page' },
        h(
          'div',
          { class: 'note err' },
          e.message,
          e.data?.hint ? h('div', { class: 'caveat' }, e.data.hint) : null,
        ),
      ),
    )
  }
}
window.addEventListener('hashchange', () => {
  render().catch(fail)
})

const poll = async () => {
  try {
    const running = await refreshRuns()
    if (state.view === 'runs') {
      renderList()
      if (running && state.selected) {
        const sel = state.runs.find((d) => d.run.id === state.selected)
        if (sel?.run.status === 'running' || state.detail?.run.status === 'running') {
          state.detail = await get(`/api/runs/${encodeURIComponent(state.selected)}`)
          renderDetail()
        }
      }
    }
    if (state.project && Boolean(state.project.activeJob) !== (state.job?.status === 'running'))
      await refreshProject()
    clearTimeout(state.timers.runs)
    state.timers.runs = setTimeout(poll, running ? 2000 : 8000)
  } catch {
    $('#liveText').textContent = 'disconnected'
    $('#live').classList.remove('on')
    state.timers.runs = setTimeout(poll, 4000)
  }
}

setInterval(() => {
  const now = Date.now()
  for (const el of document.querySelectorAll('[data-since]')) {
    const end = el.dataset.until ? new Date(el.dataset.until).getTime() : now
    el.textContent = fmtDur(end - new Date(el.dataset.since).getTime())
  }
}, 1000)

refreshProject()
  .catch(fail)
  .then(() => render())
  .then(() => poll())
  .catch(fail)
