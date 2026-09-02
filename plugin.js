/**
 * Hermes Terminal: embed the connected instance's `hermes --tui`.
 *
 * Same door as the web dashboard Chat tab: WebSocket /api/pty on the
 * gateway this Desktop window is already signed into. Local and remote
 * share that path. No core patch, no plugin_api.py.
 *
 * AUTHORING RULES (loaded UNCOMPILED):
 *  - SINGLE FILE. Evaluated from a blob URL, so sibling imports die.
 *  - Never write the word import, or the word from, followed by a quoted
 *    string. Comments included. The loader scans the whole source and
 *    treats a match as a module specifier.
 *  - No JSX. Use jsx() / jsxs() from react/jsx-runtime.
 *  - Only three specifiers resolve: @hermes/plugin-sdk, react,
 *    react/jsx-runtime.
 *  - Tailwind is build-time. Layout primitives are safe. Colors go
 *    through inline style with var(--ui-*).
 */

import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-terminal'
const PLUGIN_NAME = 'TUI'
const ROUTE = '/hermes-terminal'
const VERSION = '0.0.1'
const CHANNEL = 'hermes-terminal'
const XTERM_ESM = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'
const XTERM_ESM_ALT = 'https://esm.sh/@xterm/xterm@5.5.0'
const XTERM_UMD = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js'
const SESSION_LIMIT = 40
const RECONNECT_MS = 1200
const MINT_TIMEOUT_MS = 15000
const CONNECT_TIMEOUT_MS = 15000
const TRACE_LIMIT = 300
// The sidebar stamps our row with data-tour="sidebar-nav-<namespaced id>".
const NAV_ROW_SELECTOR = '[data-tour="sidebar-nav-' + 'hermes-terminal:nav"]'
const RAIL_MIN = 180
const RAIL_DEFAULT = 240
const RAIL_MAX = 520
const TERM_MIN = 360

const host = sdk.host
const useValue = sdk.useValue
const ROUTES_AREA = sdk.ROUTES_AREA
const SIDEBAR_NAV_AREA = sdk.SIDEBAR_NAV_AREA
const PALETTE_AREA = sdk.PALETTE_AREA
const KEYBINDS_AREA = sdk.KEYBINDS_AREA
const Button = sdk.Button
const Badge = sdk.Badge

const text = {
  primary: 'var(--ui-text-primary)',
  secondary: 'var(--ui-text-secondary)',
  tertiary: 'var(--ui-text-tertiary)',
  red: 'var(--ui-red)',
  yellow: 'var(--ui-yellow)',
  green: 'var(--ui-green)',
  accent: 'var(--ui-accent)',
  border: 'var(--ui-stroke-secondary)',
  bg: 'var(--ui-bg-editor)'
}

const attachByKey = new Map()
const $noConnection = sdk.atom ? sdk.atom(null) : { get: () => null, subscribe: () => () => {} }
const $railWidth = sdk.atom ? sdk.atom(RAIL_DEFAULT) : null
const $railHidden = sdk.atom ? sdk.atom(false) : null
const $traceLines = sdk.atom ? sdk.atom([]) : null
const $debugLog = sdk.atom ? sdk.atom(true) : null
let storage = null
let xtermCssInjected = false
let TerminalCtor = null
let xtermLoad = null

function stored(key, fallback) {
  return storage ? storage.get(key, fallback) : fallback
}

function remember(key, value) {
  if (storage) storage.set(key, value)
}

function redact(value) {
  if (typeof value !== 'string') return value
  return value.replace(/([?&](?:token|ticket)=)[^&#]*/gi, '$1<redacted>')
}

function describe(extra) {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ' ' + (extra.message || String(extra))
  if (typeof extra === 'string') return ' ' + redact(extra)
  try {
    return ' ' + redact(JSON.stringify(extra))
  } catch {
    return ' ' + String(extra)
  }
}

function stamp() {
  const d = new Date()
  const pad = (n, w) => String(n).padStart(w || 2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
}

/**
 * Lifecycle trace. Always kept in memory (the Log panel in the header). When
 * debug logging is on it also goes through console.error, which is the one
 * console level Desktop copies into desktop.log. That is how a cold-start
 * failure with no DevTools open still leaves a record on disk.
 */
function trace(msg, extra) {
  const line = stamp() + ' ' + msg + describe(extra)
  if ($traceLines) {
    const prev = $traceLines.get()
    const next = prev.length >= TRACE_LIMIT ? prev.slice(prev.length - TRACE_LIMIT + 1) : prev.slice()
    next.push(line)
    $traceLines.set(next)
  }
  if (!$debugLog || $debugLog.get()) {
    console.error('[hermes-terminal] ' + line)
  }
}

function setDebugLog(on) {
  if ($debugLog) $debugLog.set(!!on)
  remember('debugLog', !!on)
  trace(on ? 'debug log on (lines also go to desktop.log)' : 'debug log off (in-memory only)')
}

function elBox(el) {
  if (!el) return 'null'
  return (el.isConnected ? '' : 'detached ') + el.clientWidth + 'x' + el.clientHeight
}

/** What xterm has on screen: non-blank rows in the viewport, and whether its
 *  DOM/canvas layer is there. Separates two cases: bytes arrived but nothing
 *  painted, versus nothing arrived at all. */
function termSnapshot(term, el) {
  const out = {}
  try {
    const buf = term && term.buffer && term.buffer.active
    if (buf) {
      let filled = 0
      const top = buf.viewportY || 0
      for (let i = 0; i < term.rows; i += 1) {
        const line = buf.getLine(top + i)
        if (line && line.translateToString(true).trim()) filled += 1
      }
      out.filledRows = filled
      out.rows = term.rows
      out.altScreen = buf.type === 'alternate'
    }
    if (el) {
      const screen = el.querySelector('.xterm-screen')
      out.screen = screen ? screen.clientWidth + 'x' + screen.clientHeight : 'missing'
      out.canvas = el.querySelectorAll('canvas').length
      out.rowsDom = el.querySelectorAll('.xterm-rows > div').length
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  }
  return out
}

function viewportWidth() {
  const view = host.state && host.state.viewport
  const rect = view && typeof view.get === 'function' ? view.get() : null
  return (rect && rect.width) || 1200
}

function clampRail(width) {
  const max = Math.max(RAIL_MIN, Math.min(RAIL_MAX, viewportWidth() - TERM_MIN))
  const n = Number(width)
  if (!Number.isFinite(n)) return RAIL_DEFAULT
  return Math.max(RAIL_MIN, Math.min(max, Math.round(n)))
}

function setRailWidth(width) {
  const next = clampRail(width)
  if ($railWidth) $railWidth.set(next)
  remember('railWidth', next)
  return next
}

function setRailHidden(hidden) {
  if ($railHidden) $railHidden.set(!!hidden)
  remember('railHidden', !!hidden)
}

/**
 * Why the TUI is a workspace TAB and not a route page.
 *
 * Plugin pages normally register a route and a sidebar row; the row navigates
 * to the route and the Desktop's workspace route table renders the page. On a
 * remote gateway cold start that route table stops picking up contributions
 * partway through plugin loading: plugins loaded before the cut (Ledgerline,
 * Office) get their route, plugins after it (RSS, this one) do not, while the
 * sidebar rows from the very same registration batch all show up. The plugin
 * cannot repair that from outside (re-registering the route changes nothing;
 * the fiber probe showed the table frozen), so it stays out of the route
 * table altogether.
 *
 * Instead the sidebar row is kept for its chrome, its click is caught in the
 * capture phase before the Desktop navigates, and the terminal opens through
 * `host.openWorkspace`: a closeable main-area tab beside the chat, registered
 * in the pane tree, which updates live. The palette command and keybind take
 * the same door. On a Desktop without `openWorkspace` the plugin falls back to
 * the classic route page.
 */
const WORKSPACE_ID = PLUGIN_ID

let closeWorkspaceTab = null

function canOpenWorkspace() {
  return typeof host.openWorkspace === 'function'
}

/** Open the TUI tab, or front it when it is already open. */
function openTui(reason) {
  if (!canOpenWorkspace()) {
    go(ROUTE)
    return
  }
  trace('open TUI tab', { reason, alreadyOpen: !!closeWorkspaceTab })
  try {
    closeWorkspaceTab = host.openWorkspace(WORKSPACE_ID, {
      title: PLUGIN_NAME,
      headerVeto: false,
      render: () => jsx(Page, {}),
      onClose: () => {
        closeWorkspaceTab = null
        trace('TUI tab closed')
      }
    })
  } catch (err) {
    trace('openWorkspace failed, falling back to route', err)
    go(ROUTE)
  }
}

function go(route) {
  trace('navigate', route)
  if (typeof host.navigate === 'function') host.navigate(route)
}

/** Catch clicks on our sidebar row before the Desktop's own handler runs, so
 *  it never navigates to the route. Returns a disposer. */
function interceptSidebarRow() {
  if (typeof document === 'undefined' || !canOpenWorkspace()) return () => {}
  const onClick = event => {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    // The data-tour handle sits on the label span inside the row button, so a
    // click on the icon or the padding lands outside it. Match the button.
    const button = target.closest('button, [role="button"], a')
    const inRow = target.closest(NAV_ROW_SELECTOR) || (button && button.querySelector(NAV_ROW_SELECTOR))
    if (!inRow) return
    trace('sidebar row click intercepted')
    event.preventDefault()
    event.stopPropagation()
    openTui('sidebar click')
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}


function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

function xtermTheme() {
  return {
    background: cssVar('--ui-bg-editor', '#111111'),
    foreground: cssVar('--ui-text-primary', '#e8e8e8'),
    cursor: cssVar('--ui-accent', '#7aa2f7'),
    cursorAccent: cssVar('--ui-bg-editor', '#111111'),
    selectionBackground: 'rgba(122,162,247,0.35)',
    black: cssVar('--ui-text-quaternary', '#3b3b3b'),
    red: cssVar('--ui-red', '#f87171'),
    green: cssVar('--ui-green', '#4ade80'),
    yellow: cssVar('--ui-yellow', '#fbbf24'),
    blue: cssVar('--ui-accent', '#7aa2f7'),
    magenta: cssVar('--ui-accent', '#c084fc'),
    cyan: cssVar('--ui-accent', '#22d3ee'),
    white: cssVar('--ui-text-primary', '#e8e8e8')
  }
}

function injectXtermCss() {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-hermes-terminal', 'xterm')
  style.textContent = [
    '.xterm{position:relative;user-select:none;-ms-user-select:none;-webkit-user-select:none}',
    '.xterm.focus,.xterm:focus{outline:none}',
    '.xterm .xterm-helpers{position:absolute;top:0;z-index:5}',
    '.xterm .xterm-helper-textarea{position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}',
    '.xterm .composition-view{display:none}',
    '.xterm .xterm-viewport{overflow-y:scroll;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0}',
    '.xterm .xterm-screen{position:relative}',
    '.xterm .xterm-screen canvas{position:absolute;left:0;top:0}',
    '.xterm .xterm-scroll-area{visibility:hidden}',
    '.xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal}',
    '.xterm.enable-mouse-events{cursor:default}'
  ].join('')
  document.head.appendChild(style)
}

function ctorFromModule(mod) {
  if (!mod) return null
  if (typeof mod.Terminal === 'function') return mod.Terminal
  if (typeof mod.default === 'function') return mod.default
  if (mod.default && typeof mod.default.Terminal === 'function') return mod.default.Terminal
  return null
}

async function importFromUrl(url) {
  return import(url)
}

function loadUmd(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => {
      const Terminal = globalThis.Terminal
      script.remove()
      if (typeof Terminal === 'function') resolve(Terminal)
      else reject(new Error('UMD build did not expose Terminal'))
    }
    script.onerror = () => {
      script.remove()
      reject(new Error('UMD script failed to load'))
    }
    document.head.appendChild(script)
  })
}

async function loadTerminal() {
  if (typeof TerminalCtor === 'function') return TerminalCtor
  if (xtermLoad) return xtermLoad
  xtermLoad = (async () => {
    injectXtermCss()
    const errors = []
    for (const url of [XTERM_ESM, XTERM_ESM_ALT]) {
      try {
        const ctor = ctorFromModule(await importFromUrl(url))
        if (ctor) {
          TerminalCtor = ctor
          return ctor
        }
        errors.push(url + ': no Terminal export')
      } catch (err) {
        errors.push(url + ': ' + (err && err.message ? err.message : String(err)))
      }
    }
    try {
      TerminalCtor = await loadUmd(XTERM_UMD)
      return TerminalCtor
    } catch (err) {
      errors.push('umd: ' + (err && err.message ? err.message : String(err)))
    }
    throw new Error(
      'Could not load xterm.js. This plugin fetches it at runtime because the Desktop SDK does not export a terminal emulator. ' +
        errors.join(' | ')
    )
  })()
  try {
    return await xtermLoad
  } catch (err) {
    xtermLoad = null
    throw err
  }
}

function unwrapWsUrl(raw) {
  if (!raw) return null
  if (typeof raw === 'string') return raw
  if (raw.ok === false) {
    const err = new Error(raw.error || 'Could not mint a gateway WebSocket URL')
    if (raw.needsOauthLogin) err.needsOauthLogin = true
    throw err
  }
  if (typeof raw.wsUrl === 'string' && raw.wsUrl) return raw.wsUrl
  return null
}

function toPtyUrl(wsUrl, params) {
  const parsed = new URL(wsUrl)
  parsed.pathname = parsed.pathname.replace(/\/api\/ws\/?$/, '/api/pty')
  if (!/\/api\/pty\/?$/.test(parsed.pathname)) {
    const prefix = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = prefix + '/api/pty'
  }
  Object.keys(params).forEach(key => {
    const value = params[key]
    if (value === undefined || value === null || value === '') parsed.searchParams.delete(key)
    else parsed.searchParams.set(key, String(value))
  })
  return parsed.toString()
}

function attachToken(key, rotate) {
  if (rotate || !attachByKey.has(key)) attachByKey.set(key, crypto.randomUUID())
  return attachByKey.get(key)
}

function connectionKey(connectionId, profile) {
  return String(connectionId || 'local') + '\0' + String(profile || 'default')
}

async function mintPtyUrl(opts) {
  const desktop = typeof window === 'undefined' ? null : window.hermesDesktop
  if (!desktop || typeof desktop.getGatewayWsUrl !== 'function') {
    throw new Error('This Desktop build cannot mint gateway WebSocket URLs. Update Hermes Desktop.')
  }
  const profile = opts.profile && opts.profile !== 'default' ? opts.profile : null
  const connectionId = opts.connectionId
  let raw
  if (
    connectionId &&
    connectionId !== 'local' &&
    typeof desktop.getGatewayWsUrlFor === 'function'
  ) {
    raw = await desktop.getGatewayWsUrlFor({ connectionId, profile })
  } else {
    raw = await desktop.getGatewayWsUrl(profile)
  }
  const wsUrl = unwrapWsUrl(raw)
  if (!wsUrl) throw new Error('Gateway WebSocket URL was empty')
  const params = {
    attach: opts.attach,
    channel: CHANNEL
  }
  if (profile) params.profile = profile
  if (opts.resume) params.resume = opts.resume
  if (opts.fresh) params.fresh = '1'
  return toPtyUrl(wsUrl, params)
}

function closeMessage(code, reason) {
  if (code === 4401) return 'Auth failed. Sign in to this gateway again, then reconnect.'
  if (code === 4403) return 'The dashboard rejected this origin or Host header.'
  if (code === 4404) return 'Embedded TUI is disabled on this dashboard.'
  if (code === 4408) {
    return 'This machine is not allowed to open the dashboard PTY. Bind the remote dashboard to a reachable address, not 127.0.0.1.'
  }
  if (code === 1011) {
    return (
      reason ||
      'The dashboard could not spawn hermes --tui. Native Windows still needs the PTY extra, and some hosts only have a POSIX PTY inside WSL.'
    )
  }
  return reason || (code ? 'Disconnected (' + code + ')' : 'Disconnected')
}

function parseResumeFrame(data) {
  try {
    const parsed = JSON.parse(data)
    if (parsed && parsed.type === 'resume' && typeof parsed.id === 'string' && parsed.id) {
      return parsed.id
    }
  } catch {
    /* ANSI banner or other text */
  }
  return null
}

function sessionIdOf(row) {
  if (!row || typeof row !== 'object') return ''
  return String(row.id || row.session_id || row.stored_id || '').trim()
}

function sessionTitleOf(row) {
  const title = String(row && (row.title || row.preview) || '').trim()
  return title || sessionIdOf(row).slice(0, 8) || 'untitled'
}

function ago(ts) {
  if (!ts) return ''
  const ms = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  const delta = Math.max(0, Date.now() - ms)
  const min = Math.round(delta / 60000)
  if (min < 1) return 'now'
  if (min < 60) return min + 'm'
  const hr = Math.round(min / 60)
  if (hr < 48) return hr + 'h'
  return Math.round(hr / 24) + 'd'
}

function measureCell(term) {
  const dims = term._core && term._core._renderService && term._core._renderService.dimensions
  const css = dims && dims.css
  const cw = css && css.cell && css.cell.width
  const ch = css && css.cell && css.cell.height
  return {
    width: cw > 1 ? cw : 9,
    height: ch > 1 ? ch : 17
  }
}

function fitTerm(term, el) {
  if (!term || !el) return { cols: 0, rows: 0 }
  const width = el.clientWidth
  const height = el.clientHeight
  if (width < 20 || height < 20) return { cols: term.cols || 0, rows: term.rows || 0 }
  const cell = measureCell(term)
  const cols = Math.max(20, Math.floor(width / cell.width))
  const rows = Math.max(8, Math.floor(height / cell.height))
  if (cols !== term.cols || rows !== term.rows) {
    try {
      term.resize(cols, rows)
    } catch {
      /* ignore */
    }
  }
  return { cols: term.cols, rows: term.rows }
}

function withTimeout(promise, ms, label) {
  let timer = 0
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function hasSize(el) {
  return !!el && el.isConnected && el.clientWidth >= 20 && el.clientHeight >= 20
}

/**
 * Resolve once `el` is attached and laid out. xterm's render service needs a
 * real box at open() time. On a cold start the page can mount while the
 * workspace pane is still hidden, and opening then leaves xterm half built.
 */
function waitForSize(el, isCancelled) {
  if (hasSize(el)) return Promise.resolve(true)
  return new Promise(resolve => {
    let ro = null
    let poll = 0
    const done = ok => {
      if (ro) ro.disconnect()
      if (poll) clearInterval(poll)
      resolve(ok)
    }
    const check = () => {
      if (isCancelled()) return done(false)
      if (hasSize(el)) done(true)
    }
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(check)
      ro.observe(el)
    }
    poll = setInterval(check, 250)
  })
}

function headerButton(label, onClick, extra) {
  const props = {
    type: 'button',
    onClick,
    style: {
      fontSize: '0.75rem',
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid ' + text.border,
      background: 'transparent',
      color: text.secondary,
      cursor: 'pointer'
    }
  }
  if (Button) {
    return jsx(
      Button,
      Object.assign({ variant: 'ghost', size: 'sm', onClick, type: 'button' }, extra || {}, {
        children: label
      })
    )
  }
  return jsx('button', Object.assign(props, extra || {}, { children: label }))
}

function Page() {
  const gateway = useValue(host.state.gateway)
  const profile = useValue(host.state.profile) || 'default'
  const connectionId = useValue((host.state && host.state.connectionId) || $noConnection)

  const hostRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const genRef = useRef(0)
  const resumeRef = useRef('')
  // Opening the page starts a new TUI, same as the New button. Resume is
  // explicit: a click on a session row flips this off for that dial.
  const freshRef = useRef(true)
  const [hostEl, setHostEl] = useState(null)
  const [status, setStatus] = useState('boot')
  const [error, setError] = useState('')
  const [resumeId, setResumeId] = useState('')
  const [sessions, setSessions] = useState([])
  const [connectionLabel, setConnectionLabel] = useState('this gateway')
  const [listEpoch, setListEpoch] = useState(0)
  const [termEpoch, setTermEpoch] = useState(0)
  const [dragWidth, setDragWidth] = useState(null)
  const dragRef = useRef(null)
  const storedWidth = useValue($railWidth || $noConnection)
  const railHidden = useValue($railHidden || $noConnection)
  const traceLines = useValue($traceLines || $noConnection) || []
  const debugLog = useValue($debugLog || $noConnection)
  const [logOpen, setLogOpen] = useState(false)
  const viewport = useValue((host.state && host.state.viewport) || $noConnection)
  const railMax = Math.max(RAIL_MIN, Math.min(RAIL_MAX, ((viewport && viewport.width) || 1200) - TERM_MIN))
  const railWidth = Math.max(
    RAIL_MIN,
    Math.min(railMax, Math.round(Number(dragWidth == null ? storedWidth : dragWidth) || RAIL_DEFAULT))
  )

  resumeRef.current = resumeId

  useEffect(() => {
    trace('page mounted', { gateway, connectionId, profile })
    return () => trace('page unmounted')
  }, [])

  useEffect(() => {
    let cancelled = false
    if (typeof host.connections !== 'function') {
      setConnectionLabel(connectionId && connectionId !== 'local' ? connectionId : 'local')
      return undefined
    }
    host
      .connections()
      .then(rows => {
        if (cancelled) return
        const list = Array.isArray(rows) ? rows : []
        const current = list.find(row => row && row.id === connectionId)
        if (current && current.label) setConnectionLabel(current.label)
        else if (!connectionId || connectionId === 'local') setConnectionLabel('local')
        else setConnectionLabel(connectionId)
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionLabel(!connectionId || connectionId === 'local' ? 'local' : String(connectionId))
        }
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    if (gateway !== 'open' || typeof host.request !== 'function') {
      setSessions([])
      return undefined
    }
    let cancelled = false
    host
      .request('session.list', { limit: SESSION_LIMIT })
      .then(res => {
        if (cancelled) return
        const rows = res && Array.isArray(res.sessions) ? res.sessions : Array.isArray(res) ? res : []
        setSessions(rows.filter(row => sessionIdOf(row)))
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [gateway, connectionId, profile, listEpoch])

  useEffect(() => {
    const el = hostEl
    if (!el) {
      trace('effect: no host element yet')
      return undefined
    }
    let disposed = false
    const gen = ++genRef.current
    trace('effect start', { gen, gateway, connectionId, profile, resumeId, termEpoch, el: elBox(el) })
    let ws = null
    let term = null
    let ro = null
    let reconnectTimer = 0
    let connectTimer = 0
    let onDataDisp = null
    let snapshotTimers = []
    const stats = { frames: 0, bytes: 0, textFrames: 0, keysSent: 0 }
    const cancelled = () => disposed || gen !== genRef.current

    function clearConnectTimer() {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = 0
    }

    function clearSnapshotTimers() {
      snapshotTimers.forEach(id => clearTimeout(id))
      snapshotTimers = []
    }

    function scheduleSnapshots() {
      clearSnapshotTimers()
      ;[2000, 10000].forEach(delay => {
        snapshotTimers.push(
          setTimeout(() => {
            if (cancelled()) return
            trace('snapshot +' + delay / 1000 + 's', {
              gen,
              ws: ws ? ws.readyState : 'none',
              frames: stats.frames,
              bytes: stats.bytes,
              textFrames: stats.textFrames,
              keysSent: stats.keysSent,
              term: termSnapshot(term, el),
              el: elBox(el)
            })
          }, delay)
        )
      })
    }

    function sendResize() {
      if (!term || !ws || ws.readyState !== WebSocket.OPEN) return
      const size = fitTerm(term, el)
      if (size.cols > 0 && size.rows > 0) {
        try {
          ws.send('\x1b[RESIZE:' + size.cols + ';' + size.rows + ']')
        } catch {
          /* ignore */
        }
      }
    }

    function teardownSocket() {
      clearConnectTimer()
      if (ws) {
        try {
          ws.onopen = null
          ws.onclose = null
          ws.onerror = null
          ws.onmessage = null
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
        } catch {
          /* ignore */
        }
      }
      ws = null
      wsRef.current = null
    }

    function scheduleReconnect() {
      if (disposed || gen !== genRef.current) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      trace('reconnect scheduled', { gen, inMs: RECONNECT_MS })
      reconnectTimer = setTimeout(() => {
        reconnectTimer = 0
        if (!disposed && gen === genRef.current) void openSocket()
      }, RECONNECT_MS)
    }

    async function openSocket() {
      if (disposed || gen !== genRef.current) return
      if (gateway !== 'open') {
        trace('waiting: gateway not open', { gen, gateway })
        setStatus('waiting')
        setError('')
        return
      }
      teardownSocket()
      setStatus('connecting')
      setError('')
      const key = connectionKey(connectionId, profile)
      let url
      try {
        const fresh = freshRef.current
        freshRef.current = false
        trace('mint start', { gen, connectionId, profile, fresh, resume: fresh ? '' : resumeRef.current })
        // A fresh dial rotates the attach token, or the dashboard hands back
        // the PTY that was left running under the old one.
        url = await withTimeout(
          mintPtyUrl({
            connectionId,
            profile,
            resume: fresh ? undefined : resumeRef.current || undefined,
            attach: attachToken(key, fresh),
            fresh
          }),
          MINT_TIMEOUT_MS,
          'Minting the gateway ticket'
        )
        trace('mint ok', { gen, url })
      } catch (err) {
        trace('mint failed', err)
        if (disposed || gen !== genRef.current) return
        setStatus('error')
        setError(err && err.needsOauthLogin ? 'Sign in to this gateway again.' : err.message || String(err))
        return
      }
      if (disposed || gen !== genRef.current) {
        trace('mint result dropped: effect superseded', { gen, current: genRef.current })
        return
      }
      try {
        ws = new WebSocket(url)
      } catch (err) {
        trace('WebSocket ctor failed', err)
        if (disposed || gen !== genRef.current) return
        setStatus('error')
        setError(err.message || String(err))
        return
      }
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      const pending = ws
      connectTimer = setTimeout(() => {
        connectTimer = 0
        if (cancelled() || ws !== pending || pending.readyState !== WebSocket.CONNECTING) return
        trace('connect timeout: still CONNECTING', { gen, afterMs: CONNECT_TIMEOUT_MS })
        setStatus('error')
        setError('The dashboard did not answer the PTY WebSocket within ' + Math.round(CONNECT_TIMEOUT_MS / 1000) + 's.')
        try {
          pending.onclose = null
          pending.close()
        } catch {
          /* ignore */
        }
        ws = null
        wsRef.current = null
        scheduleReconnect()
      }, CONNECT_TIMEOUT_MS)
      ws.onopen = () => {
        clearConnectTimer()
        trace('ws open', { gen, el: elBox(el), cols: term && term.cols, rows: term && term.rows })
        if (disposed || gen !== genRef.current) return
        setStatus('open')
        setError('')
        sendResize()
        requestAnimationFrame(sendResize)
        scheduleSnapshots()
      }
      ws.onmessage = ev => {
        if (!term || disposed) return
        const data = ev.data
        const size = typeof data === 'string' ? data.length : data.byteLength || 0
        stats.frames += 1
        stats.bytes += size
        if (stats.frames === 1) {
          trace('first frame', { gen, kind: typeof data === 'string' ? 'text' : 'binary', bytes: size })
        }
        if (typeof data === 'string') {
          stats.textFrames += 1
          const resumed = parseResumeFrame(data)
          if (resumed) {
            trace('resume frame', { gen, id: resumed })
            return
          }
          // Text that is not the resume frame is an ANSI banner from the
          // dashboard, usually an error. Keep the start of it.
          trace('text frame', { gen, preview: data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 200) })
          term.write(data)
          return
        }
        if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data))
          return
        }
        if (ArrayBuffer.isView(data)) {
          term.write(data)
        }
      }
      ws.onclose = ev => {
        clearConnectTimer()
        trace('ws close', { gen, code: ev.code, reason: ev.reason, clean: ev.wasClean })
        if (disposed || gen !== genRef.current) return
        const msg = closeMessage(ev.code, ev.reason)
        setStatus('error')
        setError(msg)
        if (ev.code !== 4401 && ev.code !== 4403 && ev.code !== 4404 && ev.code !== 4408 && ev.code !== 1011) {
          scheduleReconnect()
        }
      }
      ws.onerror = () => {
        trace('ws error event', { gen, readyState: ws && ws.readyState })
      }
    }

    async function boot() {
      setStatus('loading')
      setError('')
      let Terminal
      try {
        Terminal = await loadTerminal()
        trace('xterm loaded', { gen, cached: typeof TerminalCtor === 'function' })
      } catch (err) {
        trace('xterm load failed', err)
        if (disposed || gen !== genRef.current) return
        setStatus('error')
        setError(err.message || String(err))
        return
      }
      if (cancelled()) return
      // A page restored at boot can mount while the workspace pane is still
      // hidden. Opening xterm in a 0x0 box leaves its render service half
      // built and the next resize throws. Wait for a real box first.
      if (!hasSize(el)) trace('waiting for host element size', { gen, el: elBox(el) })
      const sized = await waitForSize(el, cancelled)
      trace('host element ready', { gen, sized, el: elBox(el) })
      if (!sized || cancelled()) return
      try {
        term = new Terminal({
          cursorBlink: true,
          fontFamily:
            'MesloLGS NF, Cascadia Mono, JetBrains Mono, Fira Code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13,
          lineHeight: 1.2,
          macOptionIsMeta: true,
          macOptionClickForcesSelection: true,
          rightClickSelectsWord: true,
          scrollback: 5000,
          theme: xtermTheme()
        })
        termRef.current = term
        term.open(el)
        term.focus()
        const sendKeys = data => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            stats.keysSent += 1
            ws.send(data)
          } else {
            trace('keys dropped: socket not open', { gen, readyState: ws ? ws.readyState : 'none' })
          }
        }
        if (typeof term.onData === 'function') {
          onDataDisp = term.onData(sendKeys)
        } else if (term.on && typeof term.on === 'function') {
          term.on('data', sendKeys)
        }
        const size = fitTerm(term, el)
        trace('xterm opened', { gen, cols: size.cols, rows: size.rows })
        ro = new ResizeObserver(() => sendResize())
        ro.observe(el)
      } catch (err) {
        trace('xterm open failed', err)
        if (cancelled()) return
        setStatus('error')
        setError('xterm failed to start: ' + (err && err.message ? err.message : String(err)))
        return
      }
      await openSocket()
    }

    boot().catch(err => {
      trace('boot rejected', err)
      if (cancelled()) return
      setStatus('error')
      setError(err && err.message ? err.message : String(err))
    })

    return () => {
      trace('effect cleanup', { gen, frames: stats.frames, bytes: stats.bytes, keysSent: stats.keysSent })
      disposed = true
      clearSnapshotTimers()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      teardownSocket()
      if (ro) ro.disconnect()
      if (onDataDisp && typeof onDataDisp.dispose === 'function') onDataDisp.dispose()
      if (term) {
        try {
          term.dispose()
        } catch {
          /* ignore */
        }
      }
      termRef.current = null
    }
  }, [hostEl, gateway, connectionId, profile, resumeId, termEpoch])

  function bindHost(node) {
    hostRef.current = node
    setHostEl(prev => (prev === node ? prev : node))
  }

  function rotateAnd(resume, fresh) {
    trace('user: ' + (fresh ? 'new session' : 'resume ' + resume))
    attachToken(connectionKey(connectionId, profile), true)
    freshRef.current = !!fresh
    setResumeId(resume || '')
    setTermEpoch(n => n + 1)
  }

  const waiting = gateway !== 'open'
  const statusLabel =
    status === 'open'
      ? 'connected'
      : status === 'connecting'
        ? 'connecting'
        : status === 'loading'
          ? 'loading xterm'
          : status === 'waiting' || waiting
            ? 'waiting for gateway'
            : 'offline'
  const statusTone = status === 'open' ? 'ok' : status === 'error' ? 'bad' : 'warn'

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    'data-hermes-terminal-page': '',
    style: { color: text.primary, background: text.bg },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 px-3 py-2',
        style: { borderBottom: '1px solid ' + text.border, minHeight: 40 },
        children: [
          jsx('div', {
            className: 'text-sm font-medium',
            children: 'TUI'
          }),
          jsx('div', {
            className: 'truncate text-xs',
            style: { color: text.tertiary, maxWidth: 280 },
            children: connectionLabel + (profile && profile !== 'default' ? ' · ' + profile : '')
          }),
          Badge
            ? jsx(Badge, {
                variant: statusTone === 'ok' ? 'default' : statusTone === 'bad' ? 'destructive' : 'warn',
                children: statusLabel
              })
            : jsx('span', {
                className: 'text-xs',
                style: { color: status === 'open' ? text.green : text.tertiary },
                children: statusLabel
              }),
          jsx('div', { className: 'flex-1' }),
          headerButton('New', () => rotateAnd('', true)),
          headerButton('Reconnect', () => {
            trace('user: reconnect')
            setTermEpoch(n => n + 1)
          }),
          headerButton(railHidden ? 'Sessions' : 'Hide sessions', () => setRailHidden(!railHidden)),
          headerButton(logOpen ? 'Hide log' : 'Log', () => setLogOpen(!logOpen))
        ]
      }),
      error
        ? jsx('div', {
            className: 'px-3 py-2 text-xs',
            style: { color: text.red, borderBottom: '1px solid ' + text.border },
            children: error
          })
        : null,
      logOpen
        ? jsxs('div', {
            className: 'flex flex-col',
            style: { borderBottom: '1px solid ' + text.border, maxHeight: 220 },
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2 px-3 py-1 text-xs',
                style: { color: text.tertiary },
                children: [
                  jsx('span', { className: 'flex-1', children: 'Trace (' + traceLines.length + ' lines)' }),
                  jsx('button', {
                    type: 'button',
                    onClick: () => {
                      const body = traceLines.join('\n')
                      if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(body).catch(() => {})
                      }
                    },
                    style: { background: 'transparent', border: 'none', color: text.tertiary, cursor: 'pointer' },
                    children: 'copy'
                  }),
                  jsx('button', {
                    type: 'button',
                    onClick: () => {
                      if ($traceLines) $traceLines.set([])
                    },
                    style: { background: 'transparent', border: 'none', color: text.tertiary, cursor: 'pointer' },
                    children: 'clear'
                  }),
                  jsx('button', {
                    type: 'button',
                    onClick: () => setDebugLog(!debugLog),
                    title: 'When on, lines are also written to desktop.log',
                    style: { background: 'transparent', border: 'none', color: text.tertiary, cursor: 'pointer' },
                    children: debugLog ? 'desktop.log: on' : 'desktop.log: off'
                  })
                ]
              }),
              jsx('pre', {
                className: 'm-0 overflow-auto px-3 pb-2 text-[0.65rem] leading-snug',
                style: { color: text.secondary, fontFamily: 'ui-monospace, Consolas, monospace' },
                children: traceLines.length ? traceLines.join('\n') : '(empty)'
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex min-h-0 flex-1',
        children: [
          jsx('div', {
            className: 'min-h-0 min-w-0 flex-1 p-2',
            onClick: () => {
              if (termRef.current && termRef.current.focus) termRef.current.focus()
            },
            children: jsx('div', {
              ref: bindHost,
              className: 'h-full w-full overflow-hidden',
              style: { borderRadius: 8, background: '#0000' }
            })
          }),
          railHidden
            ? null
            : jsx('div', {
                onDoubleClick: event => {
                  event.preventDefault()
                  setDragWidth(null)
                  setRailWidth(RAIL_DEFAULT)
                },
                onPointerDown: event => {
                  event.preventDefault()
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    /* capture is optional */
                  }
                  dragRef.current = { startX: event.clientX, startWidth: railWidth }
                  setDragWidth(railWidth)
                },
                onPointerMove: event => {
                  const drag = dragRef.current
                  if (!drag) return
                  setDragWidth(clampRail(drag.startWidth + (drag.startX - event.clientX)))
                },
                onPointerUp: event => {
                  const drag = dragRef.current
                  if (!drag) return
                  try {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  } catch {
                    /* already released */
                  }
                  setRailWidth(clampRail(drag.startWidth + (drag.startX - event.clientX)))
                  dragRef.current = null
                  setDragWidth(null)
                },
                style: {
                  cursor: 'col-resize',
                  flexShrink: 0,
                  touchAction: 'none',
                  width: 6,
                  marginLeft: -3,
                  zIndex: 5,
                  background:
                    dragWidth == null ? 'transparent' : 'color-mix(in oklab, ' + text.accent + ' 35%, transparent)'
                },
                title: 'Drag to resize, double-click to reset'
              }),
          railHidden
            ? null
            : jsxs('div', {
                className: 'flex shrink-0 flex-col',
                style: {
                  width: railWidth,
                  borderLeft: '1px solid ' + text.border,
                  position: 'relative'
                },
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 px-3 py-2 text-xs',
                    style: { color: text.tertiary, borderBottom: '1px solid ' + text.border },
                    children: [
                      jsx('span', { className: 'flex-1', children: 'Sessions' }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setListEpoch(n => n + 1),
                        style: {
                          background: 'transparent',
                          border: 'none',
                          color: text.tertiary,
                          cursor: 'pointer',
                          fontSize: '0.7rem'
                        },
                        children: 'refresh'
                      })
                    ]
                  }),
              jsx('button', {
                type: 'button',
                onClick: () => rotateAnd('', true),
                className: 'px-3 py-2 text-left text-xs',
                style: {
                  color: resumeId ? text.secondary : text.primary,
                  background: resumeId
                    ? 'transparent'
                    : 'color-mix(in oklab, ' + text.accent + ' 12%, transparent)',
                  border: 'none',
                  cursor: 'pointer'
                },
                children: 'New TUI'
              }),
              jsx('div', {
                className: 'min-h-0 flex-1 overflow-auto',
                children: sessions.length
                  ? sessions.map(row => {
                      const id = sessionIdOf(row)
                      const active = id && id === resumeId
                      return jsxs(
                        'button',
                        {
                          type: 'button',
                          onClick: () => rotateAnd(id, false),
                          className: 'flex w-full flex-col gap-0.5 px-3 py-2 text-left',
                          children: [
                            jsx('span', {
                              className: 'truncate text-xs',
                              children: sessionTitleOf(row)
                            }),
                            jsxs('span', {
                              className: 'truncate text-[0.65rem]',
                              style: { color: text.tertiary },
                              children: [
                                ago(row.started_at || row.updated_at || row.last_active),
                                row.message_count ? ' · ' + row.message_count + ' msgs' : '',
                                row.source && row.source !== 'cli' ? ' · ' + row.source : ''
                              ]
                            })
                          ],
                          style: {
                            background: active
                              ? 'color-mix(in oklab, ' + text.accent + ' 14%, transparent)'
                              : 'transparent',
                            border: 'none',
                            borderBottom: '1px solid ' + text.border,
                            cursor: 'pointer',
                            color: text.primary
                          }
                        },
                        id
                      )
                    })
                  : jsx('div', {
                      className: 'px-3 py-3 text-xs',
                      style: { color: text.tertiary },
                      children: waiting ? 'Gateway is not connected.' : 'No sessions yet.'
                    })
              })
            ]
          })
        ]
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: 'Open the Hermes TUI of the gateway this window is connected to, local or remote. v' + VERSION,
  defaultEnabled: true,
  register(ctx) {
    storage = ctx.storage || null
    setRailWidth(stored('railWidth', RAIL_DEFAULT))
    setRailHidden(!!stored('railHidden', false))
    if ($debugLog) $debugLog.set(stored('debugLog', true) !== false)
    trace('register v' + VERSION, {
      gateway: host.state && host.state.gateway ? host.state.gateway.get() : undefined,
      connectionId: host.state && host.state.connectionId ? host.state.connectionId.get() : undefined,
      profile: host.state && host.state.profile ? host.state.profile.get() : undefined
    })
    const contributions = [
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 58,
        data: { path: ROUTE, label: PLUGIN_NAME, codicon: 'terminal' }
      }
    ]
    // Route page only where openWorkspace is missing (see WORKSPACE_ID note).
    if (!canOpenWorkspace()) {
      contributions.push({ id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Page, {}) })
    }
    if (PALETTE_AREA) {
      contributions.push({
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-terminal.open',
          label: 'TUI: Open',
          keywords: ['tui', 'cli', 'pty', 'terminal', 'dashboard', 'remote'],
          run: () => openTui('palette')
        }
      })
      contributions.push({
        id: 'debug',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-terminal.debug',
          label: 'TUI: Toggle debug log (desktop.log)',
          keywords: ['tui', 'debug', 'log', 'trace'],
          run: () => setDebugLog(!($debugLog && $debugLog.get()))
        }
      })
    }
    if (KEYBINDS_AREA) {
      contributions.push({
        id: 'open-key',
        area: KEYBINDS_AREA,
        data: {
          id: 'hermes-terminal.open',
          label: 'Open Hermes TUI',
          category: PLUGIN_NAME,
          defaults: ['mod+alt+t'],
          run: () => openTui('keybind')
        }
      })
    }
    ctx.registerMany(contributions)
    const disposeIntercept = interceptSidebarRow()
    trace('registered', { workspaceTab: canOpenWorkspace() })
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        disposeIntercept()
        if (closeWorkspaceTab) {
          const close = closeWorkspaceTab
          closeWorkspaceTab = null
          try {
            close()
          } catch {
            /* tab already gone */
          }
        }
        storage = null
      })
    }
  }
}

void VERSION
