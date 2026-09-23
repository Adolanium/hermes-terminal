const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

function atom(value) {
  return { get: () => value, set: next => { value = next } }
}

function load(file, cwd = '/projects/alpha') {
  const sockets = [], routes = [], slots = [], effects = new Map(), pending = [], timers = new Map()
  let cursor = 0, timerId = 0
  const state = { cwd: atom(cwd), gateway: atom('open'), profile: atom('default'), connectionId: atom('local') }
  const host = { state, request: async () => ({ sessions: [{ id: 'saved', title: 'Saved session' }] }) }
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    constructor(url) { this.url = new URL(url); this.readyState = 0; sockets.push(this) }
    close() { this.readyState = 3 }
    send() {}
  }
  class Terminal {
    cols = 80
    rows = 24
    open() {}
    focus() {}
    dispose() {}
    resize() {}
    onData() { return { dispose() {} } }
  }
  const context = vm.createContext({
    sdk: { host, atom, useValue: store => store.get() },
    console: { error() {} }, URL, crypto: { randomUUID }, WebSocket: Socket,
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: id => timers.delete(id),
    window: { hermesDesktop: {
      getGatewayWsUrl: async profile => { routes.push({ profile }); return 'ws://local/api/ws?ticket=local-ticket' },
      getGatewayWsUrlFor: async route => { routes.push(route); return 'wss://remote/prefix/api/ws?ticket=remote-ticket' }
    } },
    useRef: value => {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: value }
      return slots[i]
    },
    useState: value => {
      const i = cursor++
      if (!(i in slots)) slots[i] = value
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
    },
    useEffect: (effect, deps) => {
      const i = cursor++, previous = effects.get(i)
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        pending.push(() => { previous?.cleanup?.(); effects.set(i, { deps, cleanup: effect() }) })
      }
    },
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Terminal
  })
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/^import .*$/gm, '').replace('export default {', 'const plugin = {')
  vm.runInContext(source + '\nloadTerminal = async () => Terminal; globalThis.page = PluginPageContent;', context)
  function render() {
    cursor = 0
    const tree = context.page()
    while (pending.length) pending.shift()()
    return tree
  }
  function nodes(tree) {
    if (!tree || typeof tree !== 'object') return []
    const children = tree.props?.children
    return [tree, ...[children].flat().flatMap(nodes)]
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    state, sockets, routes,
    async mount() {
      const node = nodes(render()).find(node => typeof node.props?.ref === 'function')
      node.props.ref({ clientWidth: 800, clientHeight: 600, isConnected: true })
      render(); await settle(); render()
      assert.equal(sockets.length, 1)
    },
    async click(label) {
      const node = nodes(render()).find(node => node.props?.onClick &&
        nodes(node).some(child => child.props?.children === label))
      assert.ok(node, `Missing button: ${label}`)
      node.props.onClick(); render(); await settle()
    },
    async update() { render(); await settle() },
    async reconnectAutomatically() {
      sockets.at(-1).onclose({ code: 1006, reason: '', wasClean: false })
      const timer = [...timers.values()].find(timer => timer.ms === 1200)
      assert.ok(timer)
      timer.fn(); await settle()
    },
    close() { for (const effect of effects.values()) effect.cleanup?.() }
  }
}

for (const file of ['plugin.js', 'catalog/desktop/plugin.js']) {
  test(`${file}: new sessions capture the workspace; reconnects keep it; resumes omit it`, async () => {
    const app = load(file, '/projects/alpha & beta/日本語')
    try {
      await app.mount()
      const first = app.sockets[0].url
      assert.equal(first.searchParams.get('cwd'), '/projects/alpha & beta/日本語')
      assert.equal(first.searchParams.get('fresh'), '1')
      app.state.cwd.set('/projects/second')
      await app.update()
      assert.equal(app.sockets.length, 1, 'Changing workspace must not restart the terminal')
      await app.reconnectAutomatically()
      assert.equal(app.sockets.at(-1).url.searchParams.get('cwd'), '/projects/alpha & beta/日本語')
      assert.equal(app.sockets.at(-1).url.searchParams.get('attach'), first.searchParams.get('attach'))
      await app.click('Reconnect')
      assert.equal(app.sockets.at(-1).url.searchParams.get('cwd'), '/projects/alpha & beta/日本語')
      await app.click('New')
      assert.equal(app.sockets.at(-1).url.searchParams.get('cwd'), '/projects/second')
      assert.notEqual(app.sockets.at(-1).url.searchParams.get('attach'), first.searchParams.get('attach'))
      await app.click('Saved session')
      assert.equal(app.sockets.at(-1).url.searchParams.get('resume'), 'saved')
      assert.equal(app.sockets.at(-1).url.searchParams.has('cwd'), false)
    } finally { app.close() }
  })

  test(`${file}: detached workspaces and older SDKs retain default behavior`, async () => {
    for (const cwd of ['', '   ', null]) {
      const app = load(file, cwd)
      if (cwd === null) delete app.state.cwd
      try {
        await app.mount()
        assert.equal(app.sockets[0].url.searchParams.has('cwd'), false)
        assert.equal(app.sockets[0].url.searchParams.get('fresh'), '1')
      } finally { app.close() }
    }
  })

  test(`${file}: gateway switches capture that gateway's workspace and retain routing`, async () => {
    const app = load(file)
    try {
      await app.mount()
      app.state.connectionId.set('remote-box')
      app.state.profile.set('work')
      app.state.cwd.set('/srv/projects/remote')
      await app.update()
      const url = app.sockets.at(-1).url
      assert.equal(url.origin, 'wss://remote')
      assert.equal(url.pathname, '/prefix/api/pty')
      assert.equal(url.searchParams.get('cwd'), '/srv/projects/remote')
      assert.equal(url.searchParams.get('profile'), 'work')
      assert.equal(url.searchParams.get('ticket'), 'remote-ticket')
      assert.equal(app.routes.at(-1).connectionId, 'remote-box')
      app.state.cwd.set('/srv/projects/other')
      await app.click('Reconnect')
      assert.equal(app.sockets.at(-1).url.searchParams.get('cwd'), '/srv/projects/remote')
    } finally { app.close() }
  })
}
