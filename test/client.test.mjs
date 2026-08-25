/**
 * dsh-approval-diff — client bundle tests against faithful fakes (v0.7).
 *
 * The fake context implements Cordis's contract (guide 08, Case 22): `ctx.<name>`
 * property access THROWS unless declared in `inject`. The fake React executes
 * effects, keys hook state per component path, and THROWS on hook-count growth
 * (Case 16). File context is DISK-ONLY: scenarios control it through a fake
 * `fetch` standing in for the host route (transcript recovery is gone by
 * design — a prior read may lack the surrounding lines).
 *
 * Run: node test/client.test.mjs   (exit 0 = all assertions green)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_BUNDLE_PATH = pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../lib/client.js')
const HOST_ENTRY_PATH = pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../lib/index.js')

// ---------------------------------------------------------------------------
// The faithful fake context (spec §6 mkCtx, adapted to this plugin's names)
// ---------------------------------------------------------------------------

const mkCtx = (injectList, provided) => {
  const declared = new Set(injectList || [])
  const ctx = {
    inject: injectList,
    get: (name) => (declared.has(name) ? provided[name] : undefined),
    provide: (name, api) => { provided[name] = api },
    on: () => () => {},
  }
  for (const name of ['slots', 'sessions', 'eventRelay']) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!declared.has(name)) throw new Error('cannot get property "' + name + '" without inject')
        return provided[name]
      },
    })
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Fake services and wire-level fixtures
// ---------------------------------------------------------------------------

const mkFakeDocument = () => {
  const head = {
    children: [],
    appendChild(styleTag) { head.children.push(styleTag) },
  }
  return {
    head,
    createElement(tagName) {
      return {
        tagName,
        dataset: {},
        textContent: '',
        remove() {
          const index = head.children.indexOf(this)
          if (index >= 0) head.children.splice(index, 1)
        },
      }
    },
  }
}

const mkFakeSlots = () => {
  const registrations = []
  return {
    registrations,
    inject(seatKey, callback) {
      const entryDisposers = [callback()] // the seat is declared: runs now
      return () => { for (const dispose of entryDisposers) dispose() }
    },
    register(options, component) {
      const record = { options, component, disposed: false }
      registrations.push(record)
      return () => { record.disposed = true }
    },
  }
}

/** Wire-level carrier fixture: the PendingWait<'approval'> face plus respond(). */
const approvalWait = (sessionId, requestKey, approvalId, payloadFields, respondBehavior) => {
  const respondResults = []
  const wait = {
    kind: 'approval',
    key: requestKey,
    sessionId,
    payload: { approvalId, ...payloadFields },
    respond(result) {
      respondResults.push(result)
      return respondBehavior === undefined
        ? Promise.resolve({ accepted: true })
        : Promise.resolve(respondBehavior())
    },
  }
  return { wait, respondResults }
}

const runningCall = (callId, name, args) => ({
  callId,
  name,
  argsRaw: JSON.stringify(args),
  turn: 1,
  step: 1,
  time: 0,
  callView: null,
  subCalls: [],
})

/** One completed tool-call node over the runtime's tool-result root shape. */
const completedCallNode = (seq, name, args, contentBlocks) => ({
  kind: 'tool-call',
  data: { root: { kind: 'tool-result', seq, call: { name, argsRaw: JSON.stringify(args) }, content: contentBlocks ?? [], isError: false, subCalls: [] } },
})

/** A settled edit result for `callId` (minimal shape settledCallIdsOf reads). */
const settledToolCall = (callId) => ({
  kind: 'tool-call',
  data: { root: { kind: 'tool-result', seq: 99, callId, call: { name: 'edit', argsRaw: '{}' }, content: [], isError: false, subCalls: [] } },
})

/**
 * Disk-truth stand-in: map absolute path -> file content. Installing the
 * controller replaces globalThis.fetch until restore().
 */
const installDisk = (filesByPath) => {
  const requestedPaths = []
  globalThis.fetch = (url) => {
    const urlText = String(url)
    // v0.15: the observed route is gone; any stray query to it must fail
    // LOUDLY in tests rather than be silently answered.
    if (urlText.includes('/approval-diff/observed')) {
      throw new Error('test: observed route must not be queried (mirror removed in v0.15)')
    }
    const match = /^\/approval-diff\/context\?path=(.*)$/.exec(urlText)
    if (match === null) return Promise.resolve({ ok: false, json: async () => ({ error: 'bad url' }) })
    const requestedPath = decodeURIComponent(match[1])
    requestedPaths.push(requestedPath)
    const content = filesByPath[requestedPath]
    if (content === undefined) {
      return Promise.resolve({ ok: false, json: async () => ({ error: 'not found' }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({ path: requestedPath, content, truncated: false }) })
  }
  return {
    requestedPaths,
    restore() { delete globalThis.fetch },
  }
}

// ---------------------------------------------------------------------------
// Mini-React: createElement + useState/useEffect with per-path hook state
// ---------------------------------------------------------------------------

const mkMiniReact = () => {
  const hookStates = new Map() // component path -> { slots, effectRecords, renderEffects, hookCount }
  let rootElement = undefined
  let renderDepth = 0
  let rerenderQueued = false
  let currentRenderPath = undefined
  let currentHookIndex = 0
  let pendingEffectRuns = []

  const shallowDepsEqual = (previous, next) => {
    if (previous === undefined || next === undefined) return false
    if (previous.length !== next.length) return false
    for (let index = 0; index < previous.length; index++) {
      if (!Object.is(previous[index], next[index])) return false
    }
    return true
  }

  const requestRerender = () => {
    if (renderDepth > 0) { rerenderQueued = true; return }
    renderRoot()
  }

  const flattenChildren = (args) => {
    const flat = []
    for (const arg of args) {
      if (Array.isArray(arg)) flat.push(...flattenChildren(arg))
      else flat.push(arg)
    }
    return flat
  }

  const createElement = (type, props, ...args) => ({
    type,
    props: { ...(props ?? {}), children: flattenChildren(args) },
  })

  const useState = (initialValue) => {
    const state = hookStates.get(currentRenderPath)
    const slotIndex = currentHookIndex
    currentHookIndex += 1
    if (state.slots.length === slotIndex) state.slots.push({ value: initialValue })
    const slot = state.slots[slotIndex]
    const setState = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
      requestRerender()
    }
    return [slot.value, setState]
  }

  const useEffect = (effect, deps) => {
    const state = hookStates.get(currentRenderPath)
    const slotIndex = currentHookIndex
    currentHookIndex += 1
    state.renderEffects[slotIndex] = { effect, deps }
  }

  const renderComponent = (element, path) => {
    let state = hookStates.get(path)
    if (state === undefined) {
      state = { slots: [], effectRecords: [], renderEffects: [], hookCount: 0 }
      hookStates.set(path, state)
    }
    const previousHookCount = state.hookCount
    const outerRenderPath = currentRenderPath
    const outerHookIndex = currentHookIndex
    currentRenderPath = path
    currentHookIndex = 0
    let output
    try {
      output = element.type(element.props)
    } finally {
      currentRenderPath = outerRenderPath
      currentHookIndex = outerHookIndex
    }
    if (previousHookCount > 0 && currentHookIndex !== previousHookCount) {
      throw new Error(
        'MiniReact: hook count changed at ' + path + ' ('
        + previousHookCount + ' -> ' + currentHookIndex + ') — the React #310 class, guide Case 16')
    }
    state.hookCount = currentHookIndex
    pendingEffectRuns.push({ state })
    return renderElement(output, path)
  }

  const runPendingEffects = () => {
    const runs = pendingEffectRuns
    pendingEffectRuns = []
    for (const { state } of runs) {
      for (let index = 0; index < state.renderEffects.length; index++) {
        const rendered = state.renderEffects[index]
        if (rendered === undefined) continue
        const active = state.effectRecords[index]
        if (active !== undefined && shallowDepsEqual(active.deps, rendered.deps)) continue
        if (active !== undefined && active.cleanup !== undefined) active.cleanup()
        state.effectRecords[index] = { deps: rendered.deps, cleanup: rendered.effect() ?? undefined }
      }
    }
  }

  const renderElement = (element, path) => {
    if (element === null || element === undefined || element === false || element === true) return null
    if (Array.isArray(element)) {
      return element.map((child, index) => renderElement(child, path + '.' + index))
    }
    if (typeof element === 'object' && typeof element.type === 'function') {
      return renderComponent(element, path + '/' + element.type.name)
    }
    if (typeof element === 'object') {
      return {
        type: element.type,
        props: element.props,
        children: (element.props.children ?? []).map((child, index) => renderElement(child, path + '.' + index)),
      }
    }
    return element // raw text
  }

  const renderRoot = () => {
    if (rootElement === undefined) return null
    renderDepth += 1
    let output
    try {
      output = renderElement(rootElement, '$')
    } finally {
      renderDepth -= 1
    }
    runPendingEffects()
    if (rerenderQueued) {
      rerenderQueued = false
      return renderRoot()
    }
    return output
  }

  return {
    createElement,
    useState,
    useEffect,
    mount(element) {
      rootElement = element
      return renderRoot()
    },
    rerender: renderRoot,
  }
}

// ---------------------------------------------------------------------------
// Rendered-tree query + placement helpers
// ---------------------------------------------------------------------------

const collectElements = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out }
  if (node === null || node === undefined) return out
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collectElements(child, out)
  return out
}

const elementClassName = (node) => (node.props && typeof node.props.className === 'string' ? node.props.className : '')

const countByClass = (renderedTree, className) =>
  collectElements(renderedTree).filter((node) => elementClassName(node).split(/\s+/).includes(className)).length

const firstByClass = (renderedTree, className) =>
  collectElements(renderedTree).find((node) => elementClassName(node).split(/\s+/).includes(className))

const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') {
    return node === null || node === undefined || typeof node === 'boolean' ? '' : String(node)
  }
  return textOf(node.children)
}

const gridCellsOf = (renderedTree) =>
  collectElements(renderedTree).filter((node) =>
    node.props && node.props.style && typeof node.props.style.gridColumn === 'string')

/** Every grid cell must carry explicit gridColumn AND gridRow (no auto-placement; guide Case 28). */
const assertExplicitPlacement = (renderedTree, where) => {
  const cells = gridCellsOf(renderedTree)
  assert.ok(cells.length > 0, 'grid cells exist at ' + where)
  for (const cell of cells) {
    assert.ok(cell.props.style.gridRow !== undefined,
      'cell without explicit gridRow at ' + where + ' (auto-placement is forbidden — guide Case 28)')
  }
  return cells
}

const cellsAt = (cells, column, row) =>
  cells.filter((cell) => cell.props.style.gridColumn === column && cell.props.style.gridRow === row)

/** The <button> whose flattened text equals `text` exactly. */
const buttonByText = (renderedTree, text) =>
  collectElements(renderedTree)
    .find((node) => node.type === 'button' && textOf(node) === text)

/** Cells whose text equals `text` (any column) — for once-only assertions. */
const cellsWithText = (cells, text) => cells.filter((cell) => textOf(cell) === text)

// ---------------------------------------------------------------------------
// Bundle loading + fake session kit
// ---------------------------------------------------------------------------

const loadClientPlugin = (React) => {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  const source = readFileSync(CLIENT_BUNDLE_PATH, 'utf8')
  ;(0, eval)(source)
  assert.equal(registrations.length, 1, 'bundle registers exactly one module')
  assert.equal(registrations[0].id, 'dsh-approval-diff', 'module id is the package name')
  return registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
}

/** The composer seat's standard session kit over a mutable snapshot holder. */
const mkSessionKit = (sessionId, initialSnapshot, cwd) => {
  const holder = { snapshot: initialSnapshot, listState: {
    ids: [sessionId],
    byId: { [sessionId]: { sessionId, cwd, running: true, blank: false, displayTitle: sessionId } },
    current: sessionId,
    phase: 'ready',
  } }
  return {
    holder,
    propsFor: (matched) => ({
      sessionId,
      matched,
      useSession: (selector) => selector(holder.snapshot),
      useSessions: (selector) => selector(holder.listState),
    }),
    setSnapshot(nextSnapshot) { holder.snapshot = nextSnapshot },
  }
}

const snapshotOf = (pendingWaits, runningCalls) => ({
  pending: pendingWaits,
  runningCalls,
  chat: { nodes: { values: () => [] } },
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EDIT_ARGS = {
  file_path: '/w/proj/src/app.js',
  old_string: 'alpha\nbeta line\ngamma',
  new_string: 'alpha\nBETA line\ngamma\ndelta\nepsilon',
}
const WRITE_ARGS = { file_path: '/w/proj/notes/new-file.md', content: '# one\n# two\n# three\n' }

let checks = 0
const ok = (message) => { checks += 1; console.log('  ok - ' + message) }

const flushMicrotasks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

// --- Scenario 0: the host entry (shape + the context route) ------------------

const mkFakeWebServer = () => {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
}

const mkRouteExchange = (method, url) => {
  const headers = {}
  const exchange = {
    req: { method, url },
    res: {
      statusCode: 0,
      headers,
      setHeader: (name, value) => { headers[name.toLowerCase()] = value },
      ended: null,
      end(body) { exchange.res.ended = body },
    },
  }
  return exchange
}

{
  const entry = await import(HOST_ENTRY_PATH)
  assert.equal(entry.name, 'approval-diff', 'host entry name')
  assert.equal(typeof entry.apply, 'function', 'host entry exports apply (cordis object-plugin shape)')
  assert.deepEqual(entry.inject, ['fs', 'webServer'], 'host half declares its hard dependencies')

  const readFileCalls = []
  const fakeFs = {
    resolve: async (path) => ({ displayPath: path, targetKey: 'k:' + path }),
    readText: async (target) => {
      readFileCalls.push(target.displayPath)
      if (target.displayPath === '/w/missing.md') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return 'one\ntwo\nthree\n'
    },
  }
  const webServer = mkFakeWebServer()
  const dispose = entry.apply({ fs: fakeFs, webServer })
  assert.equal(webServer.routes.length, 1, 'one route registered')
  assert.equal(webServer.routes[0].path, '/approval-diff/context', 'context route path')

  const route = webServer.routes[0]
  const good = mkRouteExchange('GET', '/approval-diff/context?path=' + encodeURIComponent('/w/a.md'))
  await route.handler(good.req, good.res)
  assert.equal(good.res.statusCode, 200, 'readable path -> 200')
  assert.deepEqual(JSON.parse(good.res.ended), { path: '/w/a.md', content: 'one\ntwo\nthree\n', truncated: false },
    'route returns the file content capped-flagged')
  assert.deepEqual(readFileCalls, ['/w/a.md'], 'the requested path was read exactly once')

  const missing = mkRouteExchange('GET', '/approval-diff/context?path=' + encodeURIComponent('/w/missing.md'))
  await route.handler(missing.req, missing.res)
  assert.equal(missing.res.statusCode, 404, 'unreadable path -> 404 with the reason')

  const badMethod = mkRouteExchange('POST', '/approval-diff/context?path=/w/a.md')
  await route.handler(badMethod.req, badMethod.res)
  assert.equal(badMethod.res.statusCode, 405, 'non-GET -> 405')

  const noPath = mkRouteExchange('GET', '/approval-diff/context')
  await route.handler(noPath.req, noPath.res)
  assert.equal(noPath.res.statusCode, 400, 'missing path parameter -> 400')

  // v0.15: the observed mirror is GONE — approval-first owns never-observed
  // at the source (it probes the gate before asking), so no route, no
  // listener, no session state may remain on the host half.
  assert.ok(!webServer.routes.some((registered) => registered.path.includes('/observed')),
    'no observed route remains (the wrong-layer prediction surface is gone)')

  dispose()
  assert.equal(webServer.routes.length, 0, 'route disposed on plugin unload')
  ok('host entry: cordis shape, single context route (mirror removed), clean disposal')
}

// --- Scenario A: inject guard + registration shape --------------------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  assert.deepEqual(plugin.inject, ['slots'], 'declared inject list (slots only — the session kit comes from the seat)')

  globalThis.document = mkFakeDocument()
  const noSlots = mkCtx([], {})
  assert.throws(() => plugin.apply(noSlots), /cannot get property "slots" without inject/,
    'ctx.slots without declaration throws')
  ok('ctx.slots access throws when not declared in inject')

  const slots = mkFakeSlots()
  const dispose = plugin.apply(mkCtx(plugin.inject, { slots }))
  assert.equal(slots.registrations.length, 1, 'exactly one seat registration')
  const registration = slots.registrations[0]
  assert.equal(registration.options.name, 'conversation.composer', 'registers into the composer chain')
  assert.equal(registration.options.priority, 0, 'priority 0 — elected before the shipped card (priority 1)')
  assert.equal(typeof registration.options.select, 'function', 'chain selector present')
  assert.equal(typeof registration.component, 'function', 'takeover component present')
  assert.equal(globalThis.document.head.children.length, 1, 'style tag injected')
  assert.equal(globalThis.document.head.children[0].dataset.plugin, 'dsh-approval-diff', 'style tag namespaced')
  const shippedCss = globalThis.document.head.children[0].textContent
  assert.match(shippedCss, /max-width:90%/, 'card width = 90% of the composer area')
  assert.match(shippedCss, /\.adf-composer\{[^}]*max-height:calc\(100dvh - 200px\)/, 'viewport cap on the CARD')
  assert.match(shippedCss, /scrollbar-width:none/, 'diff scrollbars hidden')
  assert.match(shippedCss, /\[data-minimized='1'\] \.adf-body\{display:none\}/, 'minimized collapse rule present')
  assert.match(shippedCss, /\.adf-tabs\{/, 'file-tabs styles present')
  ok('apply registers one composer-chain entry (priority 0) + style tag; tabs styled')

  dispose()
  assert.equal(registration.disposed, true, 'chain registration disposed')
  assert.equal(globalThis.document.head.children.length, 0, 'style tag removed on dispose')
  ok('teardown disposes registration and style tag')
}

// --- Scenario B: the chain selector (pure routing) ---------------------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const select = slots.registrations[0].options.select

  const editWait = approvalWait('s1', 'a:r1', 'ap1', { toolName: 'edit', callId: 'c1', reason: 'edit app.js' }).wait
  const ownerWith = (interactions, runningCalls) => ({
    interactions,
    session: { runningCalls, pending: interactions, chat: { nodes: { values: () => [] } } },
  })

  assert.equal(select(ownerWith([], [])), null, 'no interactions -> null')
  assert.equal(select(undefined), null, 'undefined ownerProps -> null (selector is total)')
  ok('selector declines when nothing pends')

  assert.equal(select(ownerWith([editWait], [runningCall('c1', 'edit', EDIT_ARGS)])), editWait,
    'edit approval with args -> claimed')
  const badEditWait = approvalWait('s1', 'a:b', 'apb', { toolName: 'edit', callId: 'cb', reason: 'x' }).wait
  assert.equal(select(ownerWith([badEditWait], [runningCall('cb', 'edit', { file_path: '/w/y', old_string: 'a' })])), null,
    'malformed edit args -> declined')
  const writeWait = approvalWait('s1', 'a:r2', 'ap2', { toolName: 'write', callId: 'c2', reason: 'w' }).wait
  assert.equal(select(ownerWith([writeWait], [runningCall('c2', 'write', WRITE_ARGS)])), writeWait,
    'write approval -> claimed')
  ok('selector claims edit/write approvals with resolvable args')

  const bashWaitOf = (command, callId) =>
    approvalWait('s1', 'a:' + callId, 'ap' + callId, { toolName: 'bash', callId, reason: 'bash' }).wait
  for (const claiming of ['rm -rf /w/a /w/b', 'rm /w/x && echo done', 'unlink /w/four', 'printf "%s" ok; rm -f /w/y']) {
    const wait = bashWaitOf(claiming, 'cx')
    assert.equal(select(ownerWith([wait], [runningCall('cx', 'bash', { command: claiming })])), wait,
      'deletion command claims: ' + claiming)
  }
  for (const declining of ['ls -la', 'echo hi', 'cat a | rm b', 'rm /w/x && ls', 'rm /w/x && echo hi > /w/log', 'echo only']) {
    const wait = bashWaitOf(declining, 'cy')
    assert.equal(select(ownerWith([wait], [runningCall('cy', 'bash', { command: declining })])), null,
      'non-reviewable command declines: ' + declining)
  }
  ok('selector claims deletion-only bash (incl. echo sidecars) and declines the rest')

  const bashFirst = bashWaitOf('make build', 'cz')
  const lsCall = runningCall('cz', 'bash', { command: 'make build' })
  const editCall = runningCall('c1', 'edit', EDIT_ARGS)
  assert.equal(select(ownerWith([bashFirst, editWait], [lsCall, editCall])), editWait,
    'a declined first approval does not block a reviewable second (the card aggregates)')
  ok('selector skips non-reviewable pendings and claims the first reviewable one')
}

// --- Scenario C: edit review — diff, footer, minimize, dismiss ---------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component
  const select = slots.registrations[0].options.select

  // Empty disk (every path 404s): DISK-ONLY context means no context — the
  // diff still renders (operand-local numbering) with an explicit note.
  const { wait: editWait, respondResults: editResponds } = approvalWait(
    's1', 'a:r1', 'ap1', { toolName: 'edit', callId: 'c1', reason: 'edit app.js' })
  const kit = mkSessionKit('s1', snapshotOf([editWait], [runningCall('c1', 'edit', EDIT_ARGS)]), '/w')
  const emptyDisk = installDisk({})
  let tree = React.mount(React.createElement(component, kit.propsFor(editWait)))
  await flushMicrotasks()
  tree = React.rerender()
  assert.equal(countByClass(tree, 'adf-composer'), 1, 'takeover card renders in the composer')
  assert.equal(countByClass(tree, 'adf-same'), 4, 'unchanged operand lines are neutral context (2 rows x both sides)')
  assert.equal(countByClass(tree, 'adf-del'), 1, 'only the actually-removed line is red')
  assert.equal(countByClass(tree, 'adf-add'), 3, 'replaced line + 2 inserts are green')
  assert.match(textOf(firstByClass(tree, 'adf-count-add')), /^\+3$/, 'added count = CHANGES (3)')
  assert.match(textOf(firstByClass(tree, 'adf-count-del')), /^-1$/, 'removed count = CHANGES (1)')
  assert.ok(textOf(tree).includes('(file context unavailable)'), 'no-disk note renders')
  ok('edit review without disk: REAL diff, change counts, explicit no-context note')
  emptyDisk.restore()

  // With disk truth: anchored context + word highlights + true file numbers.
  // (Fresh path so the empty-disk failure above — now inside its retry
  // backoff window — cannot block this read; a fresh mount = a fresh
  // election, as the chain would do.)
  const appFileLines = ['p00', 'p01', 'alpha', 'beta line', 'gamma', 'p05', 'p06', 'p07']
  const EDIT_ARGS_CTX = { ...EDIT_ARGS, file_path: '/w/proj/src/ctx.js' }
  const { wait: ctxWait } = approvalWait('s1', 'a:r1c', 'ap1c', { toolName: 'edit', callId: 'c1c', reason: 'ctx' })
  kit.setSnapshot(snapshotOf([ctxWait], [runningCall('c1c', 'edit', EDIT_ARGS_CTX)]))
  const disk = installDisk({ '/w/proj/src/ctx.js': appFileLines.join('\n') + '\n' })
  try {
    let contextTree = React.mount(React.createElement(component, kit.propsFor(ctxWait)))
    await flushMicrotasks()
    contextTree = React.rerender()
    assert.equal(countByClass(contextTree, 'adf-ctx') >= 6, true,
      'context rows render from DISK (3 before x2 + trailing)')
    const cells = assertExplicitPlacement(contextTree, 'edit layout with disk context')
    const ctxTexts = collectElements(contextTree)
      .filter((node) => elementClassName(node).split(/\s+/).includes('adf-ctx'))
      .map(textOf)
    assert.ok(ctxTexts.includes('p01') && ctxTexts.includes('p00'), 'before-context from disk')
    assert.ok(ctxTexts.includes('p05'), 'after-context from disk')
    const changedRowOld = cells.filter((cell) => cell.props.style.gridColumn === '1')
      .find((cell) => textOf(cell) === '3')
    assert.ok(changedRowOld !== undefined, 'changed operand row carries its true file number (3)')
    // Word-level highlight inside the replaced row (grid row 4: two context
    // rows, then same(alpha) at 3, replace(beta line) at 4).
    const replacedLeft = cellsAt(cells, '2', '4')[0]
    const leftWords = collectElements(replacedLeft)
      .filter((node) => elementClassName(node).split(/\s+/).includes('adf-w-del')).map(textOf)
    assert.deepEqual(leftWords, ['beta '], 'word highlight = the removed word only')
    ok('edit review with disk: anchored context, true file numbers, word highlights')
  } finally {
    disk.restore()
  }

  // Allow -> exact native wire value; one-shot latch. (Fresh election:
  // the ctx mount above pruned this request's carrier.)
  kit.setSnapshot(snapshotOf([editWait], [runningCall('c1', 'edit', EDIT_ARGS)]))
  tree = React.mount(React.createElement(component, kit.propsFor(editWait)))
  firstByClass(tree, 'adf-btn-allow').props.onClick()
  await flushMicrotasks()
  tree = React.rerender()
  assert.deepEqual(editResponds, [{
    ok: true,
    value: { sessionId: 's1', approvalId: 'ap1', outcome: 'allowed-once' },
  }], 'allow click sends the native ApprovalPanel wire value verbatim')
  assert.equal(firstByClass(tree, 'adf-btn-allow').props.disabled, true, 'latch disables Allow')
  firstByClass(tree, 'adf-btn-reject').props.onClick()
  await flushMicrotasks()
  assert.equal(editResponds.length, 1, 'latched clicks do not double-answer')
  ok('allow click -> exact respond() value; one-shot latch holds')

  // Resolution -> selector declines.
  kit.setSnapshot(snapshotOf([], []))
  assert.equal(select({ interactions: [], session: kit.holder.snapshot }), null, 'resolution -> decline')
  ok('resolution -> takeover leaves via the selector')

  // × dismisses the FILE TAB; the native card serves that file; selector skips it.
  const { wait: editWaitTwo } = approvalWait('s1', 'a:r3', 'ap3', { toolName: 'edit', callId: 'c3', reason: 'again' })
  kit.setSnapshot(snapshotOf([editWaitTwo], [runningCall('c3', 'edit', EDIT_ARGS)]))
  tree = React.mount(React.createElement(component, kit.propsFor(editWaitTwo)))
  const dismissButton = collectElements(tree)
    .find((node) => node.props && node.props['aria-label'] === 'Use the standard approval card for this request')
  dismissButton.props.onClick()
  assert.equal(select({ interactions: [editWaitTwo], session: kit.holder.snapshot }), null,
    'dismissed tab -> selector declines (native card takes over)')
  ok('close button falls back to the native card for that FILE')

  // Refused receipt: re-armed buttons + reason. (Own file: the dismiss above
  // keyed the shared path to the native card for as long as IT pends.)
  const REFUSED_ARGS = { ...EDIT_ARGS, file_path: '/w/other.md' }
  const { wait: refusedWait } = approvalWait('s1', 'a:d2', 'apd2', { toolName: 'edit', callId: 'cd2', reason: 'x' },
    () => ({ accepted: false, reason: 'stale rpc generation' }))
  kit.setSnapshot(snapshotOf([refusedWait], [runningCall('cd2', 'edit', REFUSED_ARGS)]))
  tree = React.mount(React.createElement(component, kit.propsFor(refusedWait)))
  firstByClass(tree, 'adf-btn-reject').props.onClick()
  await flushMicrotasks()
  tree = React.rerender()
  assert.notEqual(firstByClass(tree, 'adf-btn-reject').props.disabled, true, 'refused receipt re-arms Reject')
  assert.match(textOf(firstByClass(tree, 'adf-error')), /stale rpc generation/, 'refusal reason shown')
  ok('refused receipt -> buttons re-armed, reason shown')

  // Minimize: collapses without deciding or falling through.
  const minimizeButton = collectElements(tree)
    .find((node) => node.props && node.props['aria-label'] === 'Minimize the review card')
  minimizeButton.props.onClick()
  tree = React.rerender()
  assert.equal(firstByClass(tree, 'adf-composer').props['data-minimized'], '1', 'card minimized')
  assert.equal(select({ interactions: [refusedWait], session: kit.holder.snapshot }), refusedWait,
    'minimized tab is still OURS (no fallthrough)')
  const expandButton = collectElements(tree)
    .find((node) => node.props && node.props['aria-label'] === 'Expand the review card')
  expandButton.props.onClick()
  tree = React.rerender()
  assert.equal(firstByClass(tree, 'adf-composer').props['data-minimized'], '0', 'card restored')
  ok('minimize collapses without deciding; expand restores')

  // Underivable: notice, never a blank composer.
  kit.setSnapshot(snapshotOf([refusedWait], []))
  tree = React.rerender()
  assert.equal(countByClass(tree, 'adf-notice'), 1, 'notice renders instead of a blank composer')
  ok('underivable review -> transient notice card (composer never blanks)')
}

// --- Scenario D: write review — one-sided, zero counts hidden ----------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  const { wait: writeWait } = approvalWait('s1', 'a:w1', 'apw1', { toolName: 'write', callId: 'cw', reason: 'write' })
  const kit = mkSessionKit('s1', snapshotOf([writeWait], [runningCall('cw', 'write', WRITE_ARGS)]), '/w')
  const tree = React.mount(React.createElement(component, kit.propsFor(writeWait)))

  assert.equal(countByClass(tree, 'adf-newfile'), 1, '(new file) row present')
  assert.equal(countByClass(tree, 'adf-add'), 3, 'content lines green')
  assert.equal(countByClass(tree, 'adf-del'), 0, 'no red rows for a new file')
  assert.match(textOf(firstByClass(tree, 'adf-count-add')), /^\+3$/, 'added count +3')
  assert.equal(countByClass(tree, 'adf-count-del'), 0, 'no -0 count (zero hides)')
  const cells = assertExplicitPlacement(tree, 'new-file layout')
  assert.equal(textOf(cellsAt(cells, '1 / -1', '1')[0]), '(new file)', '(new file) fills row 1')
  assert.equal(textOf(cellsAt(cells, '2', '2')[0]), '# one', 'first content line at row 2 column 2')
  ok('write review: ONE-sided green card, +3 only (no -0), explicit placement')
}

// --- Scenario E: deletion review — disk content, badges, footer ---------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  // Deletion with disk truth: FULL current content, no staleness caveat.
  const rmCommand = 'rm -rf /w/scratch/one.md'
  const { wait: rmWait, respondResults: rmResponds } = approvalWait(
    's1', 'a:e1', 'ape1', { toolName: 'bash', callId: 'ce1', reason: 'rm' })
  const disk = installDisk({ '/w/scratch/one.md': 'd1\nd2\nd3\nd4\nd5\n' })
  try {
    const kit = mkSessionKit('s1', snapshotOf([rmWait], [runningCall('ce1', 'bash', { command: rmCommand })]), '/w')
    let tree = React.mount(React.createElement(component, kit.propsFor(rmWait)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.equal(countByClass(tree, 'adf-path'), 1, 'one path row')
    assert.equal(countByClass(tree, 'adf-deleted-badge'), 1, '(deleted) badge')
    assert.equal(countByClass(tree, 'adf-del'), 5, 'full DISK content on red rows')
    assert.equal(firstByClass(tree, 'adf-path').props.title, 'content as currently on disk',
      'no staleness caveat for disk truth')
    firstByClass(tree, 'adf-btn-reject').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(rmResponds.map((result) => result.value.outcome), ['rejected'],
      'deletion decision delivered through respond()')
    ok('deletion review from DISK: full content, no caveat, footer answers')
  } finally {
    disk.restore()
  }

  // No disk (file unreadable): explicit unavailability, still answerable.
  const { wait: unlinkWait } = approvalWait('s1', 'a:e5', 'ape5', { toolName: 'bash', callId: 'ce5', reason: 'u' })
  const kit = mkSessionKit('s1', snapshotOf([unlinkWait], [runningCall('ce5', 'bash', { command: 'unlink /w/scratch/four.md' })]), '/w')
  const tree = React.mount(React.createElement(component, kit.propsFor(unlinkWait)))
  assert.ok(textOf(tree).includes('(content unavailable)'), 'unavailable note renders')
  assert.match(textOf(firstByClass(tree, 'adf-more')), /^unlink$/, 'unlink badge')
  ok('deletion without disk: explicit unavailability note, badge, still answerable')
}

// --- Scenario F: merged multi-hunk — dedup, ordering, one Allow ---------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  // A 14-line file; hunk A edits line 2, hunk B edits line 7 — their context
  // windows OVERLAP (A's after-context == B's before-context lines).
  // v0.17 shape: ONE pending (exclusive tools ask sequentially) + hunk B as
  // the step's CONTIGUOUS same-file queued sibling.
  const fileLines = ['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07', 'f08', 'f09', 'f10', 'f11', 'f12', 'f13', 'f14']
  const hunkA = { file_path: '/w/multi.md', old_string: 'f02', new_string: 'f02 A\nf02 A2' }
  const hunkB = { file_path: '/w/multi.md', old_string: 'f07', new_string: 'f07 B' }
  const { wait: waitA, respondResults: respondsA } = approvalWait('s1', 'a:ma', 'apma', { toolName: 'edit', callId: 'cma', reason: 'a' })
  const { wait: waitB, respondResults: respondsB } = approvalWait('s1', 'a:mb', 'apmb', { toolName: 'edit', callId: 'cmb', reason: 'b' })
  const stepNode = { kind: 'assistant-step', anchorSeq: 40, data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [
    { kind: 'tool-call', callId: 'cma', name: 'edit', argsRaw: JSON.stringify(hunkA) },
    { kind: 'tool-call', callId: 'cmb', name: 'edit', argsRaw: JSON.stringify(hunkB) },
  ] } }
  const kit = mkSessionKit('s1',
    snapshotOf([waitA], [runningCall('cma', 'edit', hunkA)]), '/w')
  kit.holder.snapshot.chat = { nodes: { values: () => [stepNode] } }
  const disk = installDisk({ '/w/multi.md': fileLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(waitA)))
    await flushMicrotasks()
    tree = React.rerender()

    assert.equal(firstByClass(tree, 'adf-composer').props['data-hunk-count'], '2', 'both hunks in one card (pending + contiguous queued sibling)')
    assert.match(textOf(firstByClass(tree, 'adf-head-title')), /Review pending changes/, 'review-related title')
    assert.equal(countByClass(tree, 'adf-tabs'), 0, 'one file -> no tab strip')
    assert.match(textOf(firstByClass(tree, 'adf-head-basename')), /multi\.md/,
      'SINGLE file: the header names it (no tabs to carry identity)')

    // DEDUP CONTRACT: every file line renders AT MOST ONCE. f03..f06 sit in
    // BOTH hunks' context windows — each must appear exactly once per side.
    const cells = assertExplicitPlacement(tree, 'merged layout')
    for (const sharedLine of ['f03', 'f04', 'f05', 'f06']) {
      const occurrences = cellsWithText(cells, sharedLine)
      assert.equal(occurrences.length, 2,
        sharedLine + ' renders exactly once per side (got ' + occurrences.length + ') — no duplicated between-lines')
    }
    // Hunks in file order (A above B), adjacent windows -> no unchanged band.
    const rowOf = (text) => {
      const cell = cells.find((candidate) => textOf(candidate) === text)
      return cell !== undefined ? Number(cell.props.style.gridRow) : undefined
    }
    assert.ok(rowOf('f02 A') < rowOf('f07 B'), 'hunks render in file order')
    assert.equal(countByClass(tree, 'adf-hunkgap'), 0, 'overlapping context windows -> no unchanged band')

    // True file numbers: hunk A at line 2; its +1 line shifts hunk B's NEW
    // side by one (old 7 -> new 8).
    const changedA = cells.find((cell) => textOf(cell) === 'f02 A')
    const changedB = cells.find((cell) => textOf(cell) === 'f07 B')
    assert.equal(changedB.props.style.gridRow !== undefined && changedA.props.style.gridRow !== undefined, true,
      'changed rows present')
    const oldNumberOfB = cells
      .filter((cell) => cell.props.style.gridColumn === '1' && Number(cell.props.style.gridRow) === Number(changedB.props.style.gridRow))
      .map(textOf)[0]
    const newNumberOfB = cells
      .filter((cell) => cell.props.style.gridColumn === '3' && Number(cell.props.style.gridRow) === Number(changedB.props.style.gridRow))
      .map(textOf)[0]
    assert.equal(oldNumberOfB, '7', 'hunk B old side keeps its file number (7)')
    assert.equal(newNumberOfB, '8', 'hunk B new side shifted by hunk A\'s +1-line delta (8)')

    // One Allow answers the live ask AND arms the contiguous queued sibling.
    firstByClass(tree, 'adf-btn-allow').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsA.map((result) => result.value.outcome), ['allowed-once'], 'hunk A answered')
    assert.deepEqual(respondsB.map((result) => result.value.outcome), [],
      'hunk B not delivered yet (armed; its frame has not arrived)')
    // Its frame arrives -> the armed decision delivers automatically.
    kit.setSnapshot(snapshotOf([waitB], [runningCall('cmb', 'edit', hunkB)]))
    kit.holder.snapshot.chat = { nodes: { values: () => [stepNode] } }
    tree = React.mount(React.createElement(component, kit.propsFor(waitB)))
    await flushMicrotasks()
    tree = React.rerender()
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsB.map((result) => result.value.outcome), ['allowed-once'],
      'hunk B auto-delivered on its own frame')
    ok('merged hunks: dedup between-lines, file order, delta-numbered, one Allow answers the run')
  } finally {
    disk.restore()
  }

  // DISTANT hunks: skipped lines between the windows -> exactly one band.
  // v0.17 shape: one pending + the distant sibling queued in the same step.
  const distantA = { file_path: '/w/multi.md', old_string: 'f01', new_string: 'f01 D' }
  const distantB = { file_path: '/w/multi.md', old_string: 'f14', new_string: 'f14 D' }
  const { wait: waitDA } = approvalWait('s1', 'a:da', 'apda', { toolName: 'edit', callId: 'cda', reason: 'a' })
  const { wait: waitDB } = approvalWait('s1', 'a:db', 'apdb', { toolName: 'edit', callId: 'cdb', reason: 'b' })
  const stepD = { kind: 'assistant-step', anchorSeq: 41, data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [
    { kind: 'tool-call', callId: 'cda', name: 'edit', argsRaw: JSON.stringify(distantA) },
    { kind: 'tool-call', callId: 'cdb', name: 'edit', argsRaw: JSON.stringify(distantB) },
  ] } }
  const kitD = mkSessionKit('s1',
    snapshotOf([waitDA], [runningCall('cda', 'edit', distantA)]), '/w')
  kitD.holder.snapshot.chat = { nodes: { values: () => [stepD] } }
  const diskD = installDisk({ '/w/multi.md': fileLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kitD.propsFor(waitDA)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.equal(countByClass(tree, 'adf-ellipsis'), 2,
      'distant hunks -> one middle ellipsis row (2 cells) where lines were skipped')
    const cells = gridCellsOf(tree)
    for (const skipped of ['f05', 'f06', 'f07', 'f08', 'f09', 'f10']) {
      assert.equal(cellsWithText(cells, skipped).length, 0, 'skipped middle lines not rendered: ' + skipped)
    }
    for (const shown of ['f02', 'f04', 'f11', 'f13']) {
      assert.equal(cellsWithText(cells, shown).length, 2, 'gap-edge context rendered once per side: ' + shown)
    }
    ok('distant hunks: one ellipsis band, middle lines omitted (never duplicated)')
  } finally {
    diskD.restore()
  }
}

// --- Scenario G: ONE FILE PER CARD — different files never share (v0.17) -----

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component
  const select = slots.registrations[0].options.select

  // One step: alpha edit (leading), beta edit, then ANOTHER alpha edit. The
  // alpha card merges ONLY the contiguous run (none here — beta breaks it);
  // the trailing alpha call must NOT appear (its turn is behind beta's).
  const fileA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
  const fileB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']
  const editA1 = { file_path: '/w/alpha.md', old_string: 'a2', new_string: 'a2 EDITED' }
  const editB = { file_path: '/w/beta.md', old_string: 'b5', new_string: 'b5 EDITED' }
  const editA2 = { file_path: '/w/alpha.md', old_string: 'a4', new_string: 'a4 SECOND' }
  const { wait: waitA, respondResults: respondsA } = approvalWait('s1', 'a:ta', 'apta', { toolName: 'edit', callId: 'cta', reason: 'a' })
  const { wait: waitB, respondResults: respondsB } = approvalWait('s1', 'a:tb', 'aptb', { toolName: 'edit', callId: 'ctb', reason: 'b' })
  const { wait: waitA2, respondResults: respondsA2 } = approvalWait('s1', 'a:ta2', 'apta2', { toolName: 'edit', callId: 'cta2', reason: 'a2' })
  const stepNode = { kind: 'assistant-step', anchorSeq: 60, data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [
    { kind: 'tool-call', callId: 'cta', name: 'edit', argsRaw: JSON.stringify(editA1) },
    { kind: 'tool-call', callId: 'ctb', name: 'edit', argsRaw: JSON.stringify(editB) },
    { kind: 'tool-call', callId: 'cta2', name: 'edit', argsRaw: JSON.stringify(editA2) },
  ] } }
  const kit = mkSessionKit('s1',
    snapshotOf([waitA], [runningCall('cta', 'edit', editA1)]), '/w')
  kit.holder.snapshot.chat = { nodes: { values: () => [stepNode] } }
  const disk = installDisk({ '/w/alpha.md': fileA.join('\n') + '\n', '/w/beta.md': fileB.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(waitA)))
    await flushMicrotasks()
    tree = React.rerender()

    assert.equal(firstByClass(tree, 'adf-composer').props['data-tab-count'], '1', 'exactly one tab (one file)')
    assert.equal(countByClass(tree, 'adf-tab'), 0, 'no tab strip can render (single tab)')
    assert.equal(countByClass(tree, 'adf-head-basename'), 1, 'single file: the header names it')
    assert.ok(collectElements(tree).some((node) => textOf(node) === 'a2 EDITED'),
      'the card renders ITS OWN diff')
    assert.ok(!collectElements(tree).some((node) => textOf(node) === 'b5 EDITED'),
      'a DIFFERENT file\'s diff is NOT rendered')
    assert.ok(!collectElements(tree).some((node) => textOf(node) === 'a4 SECOND'),
      'a NON-CONTIGUOUS same-file later call is NOT rendered (its turn is behind beta\'s)')
    assert.ok(collectElements(tree).every((node) => {
      const classes = elementClassName(node).split(/\s+/)
      return !(classes.includes('adf-btn') && /all \d/.test(textOf(node)))
    }), 'no global all-N buttons exist')

    // Footer answers ONLY this card's file.
    buttonByText(tree, 'Allow').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsA.map((result) => result.value.outcome), ['allowed-once'], 'alpha answered')
    assert.deepEqual(respondsB.map((result) => result.value.outcome), [], 'beta NOT answered from alpha\'s card')
    assert.deepEqual(respondsA2.map((result) => result.value.outcome), [], 'later alpha call NOT answered (not in the run)')
    ok('one file per card: own diff only; non-contiguous same-file and cross-file calls excluded')

    // Beta's turn: its own card, decided independently.
    kit.setSnapshot(snapshotOf([waitB], [runningCall('ctb', 'edit', editB)]))
    kit.holder.snapshot.chat = { nodes: { values: () => [stepNode, settledToolCall('cta')] } }
    tree = React.mount(React.createElement(component, kit.propsFor(waitB)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.ok(collectElements(tree).some((node) => textOf(node) === 'b5 EDITED'), 'beta card renders beta')
    assert.ok(!collectElements(tree).some((node) => textOf(node) === 'a2 EDITED'),
      'alpha\'s settled call is not re-rendered')
    firstByClass(tree, 'adf-btn-reject').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsB.map((result) => result.value.outcome), ['rejected'], 'beta decided on its own card')
    ok('each file decided on its own card in its own turn')
  } finally {
    disk.restore()
  }

  // CONTIGUOUS run merges: two leading alpha calls + beta after -> ONE card
  // carries both alpha hunks; beta stays out.
  {
    const editA3 = { file_path: '/w/alpha.md', old_string: 'a3', new_string: 'a3 THIRD' }
    const { wait: waitA3 } = approvalWait('s1', 'a:ta3', 'apta3', { toolName: 'edit', callId: 'cta3', reason: 'a3' })
    const { wait: waitB2 } = approvalWait('s1', 'a:tb2', 'aptb2', { toolName: 'edit', callId: 'ctb2', reason: 'b2' })
    const stepNode2 = { kind: 'assistant-step', anchorSeq: 61, data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [
      { kind: 'tool-call', callId: 'cta', name: 'edit', argsRaw: JSON.stringify(editA1) },
      { kind: 'tool-call', callId: 'cta3', name: 'edit', argsRaw: JSON.stringify(editA3) },
      { kind: 'tool-call', callId: 'ctb2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/beta.md', old_string: 'b1', new_string: 'b1 X' }) },
    ] } }
    const kitC = mkSessionKit('s1', snapshotOf([waitA3], [runningCall('cta3', 'edit', editA3)]), '/w')
    // The pending is a3 (the run head must be the PENDING call's file —
    // simulate the real order: cta settled, cta3 pending).
    kitC.holder.snapshot.chat = { nodes: { values: () => [stepNode2, settledToolCall('cta')] } }
    const diskC = installDisk({ '/w/alpha.md': fileA.join('\n') + '\n', '/w/beta.md': fileB.join('\n') + '\n' })
    try {
      // Re-mount with cta pending to check the leading-run merge directly.
      const kitL = mkSessionKit('s1', snapshotOf([waitA], [runningCall('cta', 'edit', editA1)]), '/w')
      kitL.holder.snapshot.chat = { nodes: { values: () => [stepNode2] } }
      const { wait: waitALead } = approvalWait('s1', 'a:tlead', 'aptlead', { toolName: 'edit', callId: 'cta', reason: 'lead' })
      const treeL = React.mount(React.createElement(component, kitL.propsFor(kitL.holder.snapshot.pending[0])))
      await flushMicrotasks()
      const rerenderedL = React.rerender()
      assert.equal(firstByClass(rerenderedL, 'adf-composer').props['data-hunk-count'], '2',
        'contiguous same-file run merges into one card')
      assert.ok(!collectElements(rerenderedL).some((node) => textOf(node) === 'b1 X'),
        'the run STOPS at the different file')
      ok('contiguous same-file run merges; run stops at the first different file')
    } finally {
      diskC.restore()
    }
  }

  // × dismisses THIS file's card; the file falls back to the native card.
  {
    const { wait: waitC } = approvalWait('s1', 'a:tc', 'aptc', { toolName: 'edit', callId: 'ctc', reason: 'c' })
    const { wait: waitD } = approvalWait('s1', 'a:td', 'aptd', { toolName: 'edit', callId: 'ctd', reason: 'd' })
    const editC = { file_path: '/w/alpha.md', old_string: 'a1', new_string: 'a1' }
    const editD = { file_path: '/w/beta.md', old_string: 'b1', new_string: 'b1' }
    const kit2 = mkSessionKit('s1',
      snapshotOf([waitC, waitD], [runningCall('ctc', 'edit', editC), runningCall('ctd', 'edit', editD)]), '/w')
    let tree2 = React.mount(React.createElement(component, kit2.propsFor(waitC)))
    const dismissButton = collectElements(tree2)
      .find((node) => node.props && node.props['aria-label'] === 'Use the standard approval card for this request')
    dismissButton.props.onClick()
    tree2 = React.rerender()
    const matchedAfterDismiss = select({ interactions: [waitC, waitD], session: kit2.holder.snapshot })
    assert.equal(matchedAfterDismiss, waitD, 'selector still claims for the other file (alpha goes native)')
    ok('dismiss is per FILE: alpha falls back, beta keeps the card')
  }
}

// --- Scenario H: the QUEUED BATCH — one step, many calls, sequential asks ----

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component
  const select = slots.registrations[0].options.select

  // One assistant step carrying FOUR file-changing calls (like a parallel
  // volley the scheduler runs one-by-one): three edits on big.md + a write.
  const bigLines = ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10']
  const editOne = { file_path: '/w/big.md', old_string: 'b02', new_string: 'b02 ONE' }
  const editTwo = { file_path: '/w/big.md', old_string: 'b05', new_string: 'b05 TWO' }
  const editThree = { file_path: '/w/big.md', old_string: 'b09', new_string: 'b09 THREE' }
  const writeNew = { file_path: '/w/new.md', content: 'n1\nn2\n' }
  // REAL chat-node shape (verified in source: ui-conversation assistant.ts /
  // chat-nodes.ts): kind 'assistant-step', blocks at data.blocks.
  const stepNode = {
    kind: 'assistant-step',
    anchorSeq: 50,
    data: {
      status: 'settled',
      turn: 1,
      step: 1,
      time: 0,
      blocks: [
        { kind: 'tool-call', callId: 'k1', name: 'edit', argsRaw: JSON.stringify(editOne) },
        { kind: 'tool-call', callId: 'k2', name: 'edit', argsRaw: JSON.stringify(editTwo) },
        { kind: 'tool-call', callId: 'k3', name: 'edit', argsRaw: JSON.stringify(editThree) },
        { kind: 'tool-call', callId: 'k4', name: 'write', argsRaw: JSON.stringify(writeNew) },
      ],
    },
  }
  const { wait: waitOne, respondResults: respondsOne } = approvalWait('s1', 'a:q1', 'apq1', { toolName: 'edit', callId: 'k1', reason: 'one' })
  const kit = mkSessionKit('s1', {
    pending: [waitOne],
    runningCalls: [runningCall('k1', 'edit', editOne)],
    chat: { nodes: { values: () => [stepNode] } },
  }, '/w')
  const disk = installDisk({ '/w/big.md': bigLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(waitOne)))
    await flushMicrotasks()
    tree = React.rerender()

    // v0.17: ONE card = the pending call's CONTIGUOUS same-file run (k1-k3
    // all on big.md); the write on new.md is a different file — NOT here.
    assert.equal(firstByClass(tree, 'adf-composer').props['data-tab-count'], '1', 'one file per card')
    assert.equal(countByClass(tree, 'adf-tab'), 0, 'no tab strip')
    assert.equal(firstByClass(tree, 'adf-composer').props['data-hunk-count'], '3', 'big.md aggregates the CONTIGUOUS run')
    assert.ok(!/\/ \d/.test(textOf(firstByClass(tree, 'adf-actions'))),
      'no N/M counter in the footer (it suggested partial decisions)')

    const cells = gridCellsOf(tree)
    for (const changed of ['b02 ONE', 'b05 TWO', 'b09 THREE']) {
      assert.ok(cells.some((cell) => textOf(cell) === changed), 'hunk renders: ' + changed)
    }
    assert.ok(!cells.some((cell) => textOf(cell) === 'n1'), 'the write\'s file is NOT on this card')
    assert.ok(cells.some((cell) => String(cell.props.className).includes('adf-queued')), 'queued hunks dimmed')
    const rowOf = (text) => {
      const cell = cells.find((candidate) => textOf(candidate) === text)
      return cell !== undefined ? Number(cell.props.style.gridRow) : undefined
    }
    assert.ok(rowOf('b02 ONE') < rowOf('b05 TWO') && rowOf('b05 TWO') < rowOf('b09 THREE'),
      'run hunks render in file order')

    // Footer: exactly TWO buttons (Reject / Allow), scoped to this file's run.
    assert.equal(collectElements(tree).filter((node) => elementClassName(node).split(/\s+/).includes('adf-btn')).length, 2,
      'exactly two decision buttons')
    buttonByText(tree, 'Allow').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsOne.map((result) => result.value.outcome), ['allowed-once'], 'the live approval answered')
    ok('contiguous run: one card, one file, 3 hunks, two file-scoped buttons')

    // Advance: k1 settled, k2's frame arrives -> AUTO-delivered (the Allow
    // armed this file's queued siblings).
    const { wait: waitTwo, respondResults: respondsTwo } = approvalWait('s1', 'a:q2', 'apq2', { toolName: 'edit', callId: 'k2', reason: 'two' })
    const settledOne = {
      kind: 'tool-call',
      data: { root: { kind: 'tool-result', seq: 51, callId: 'k1', call: { name: 'edit', argsRaw: JSON.stringify(editOne) }, content: [], isError: false, subCalls: [] } },
    }
    kit.setSnapshot({
      pending: [waitTwo],
      runningCalls: [runningCall('k2', 'edit', editTwo)],
      chat: { nodes: { values: () => [stepNode, settledOne] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitTwo)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsTwo.map((result) => result.value.outcome), ['allowed-once'],
      'the armed decision auto-delivered when k2\'s approval arrived')
    assert.equal(firstByClass(tree, 'adf-composer').props['data-hunk-count'], '2',
      'applied edit leaves the run (k2 pending + k3 queued remain)')
    ok('run advances: applied calls drop out, armed decisions deliver')

    // k3's turn: last of the run, auto-delivered; then the WRITE gets its own
    // card at its own turn (cross-file never joins).
    const { wait: waitThree, respondResults: respondsThree } = approvalWait('s1', 'a:q3', 'apq3', { toolName: 'edit', callId: 'k3', reason: 'three' })
    const { wait: waitFour, respondResults: respondsFour } = approvalWait('s1', 'a:q4', 'apq4', { toolName: 'write', callId: 'k4', reason: 'four' })
    kit.setSnapshot({
      pending: [waitThree],
      runningCalls: [runningCall('k3', 'edit', editThree)],
      chat: { nodes: { values: () => [stepNode, settledOne] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitThree)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsThree.map((result) => result.value.outcome), ['allowed-once'],
      'k3 auto-delivered (armed by the run\'s Allow)')
    // The write's turn: its OWN card, its own decision — never on big.md's.
    kit.setSnapshot({
      pending: [waitFour],
      runningCalls: [runningCall('k4', 'write', writeNew)],
      chat: { nodes: { values: () => [stepNode, settledOne, settledToolCall('k3')] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitFour)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.ok(collectElements(tree).some((node) => textOf(node) === 'n1'),
      'the write renders on ITS OWN card at its turn')
    assert.equal(firstByClass(tree, 'adf-composer').props['data-hunk-count'], '0',
      'the write card carries no big.md hunks')
    assert.deepEqual(respondsFour.map((result) => result.value.outcome), [],
      'the write was NOT pre-decided by big.md\'s Allow (different file, not in the run)')
    buttonByText(tree, 'Allow').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsFour.map((result) => result.value.outcome), ['allowed-once'], 'write decided on its own card')
    ok('run ends at the file boundary: the write gets its own card, own decision')
  } finally {
    disk.restore()
  }

  // Queued calls alone never claim the composer — a live approval is required.
  const emptyKit = mkSessionKit('s1', {
    pending: [],
    runningCalls: [],
    chat: { nodes: { values: () => [stepNode] } },
  }, '/w')
  assert.equal(select({ interactions: [], session: emptyKit.holder.snapshot }), null,
    'no live approval -> decline even with queued calls in the step')
  ok('queued calls alone never claim the composer')
}

// --- Scenario I: BATCH DECIDE — one click, automatic delivery (v0.9) ---------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  const bigLines = ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10']
  const editOne = { file_path: '/w/big.md', old_string: 'b02', new_string: 'b02 ONE' }
  const editTwo = { file_path: '/w/big.md', old_string: 'b05', new_string: 'b05 TWO' }
  const editThree = { file_path: '/w/big.md', old_string: 'b09', new_string: 'b09 THREE' }
  const writeNew = { file_path: '/w/new.md', content: 'n1\nn2\n' }
  // REAL chat-node shape: kind 'assistant-step', blocks at data.blocks.
  const stepNode = {
    kind: 'assistant-step',
    anchorSeq: 60,
    data: {
      status: 'settled',
      turn: 1,
      step: 1,
      time: 0,
      blocks: [
        { kind: 'tool-call', callId: 'j1', name: 'edit', argsRaw: JSON.stringify(editOne) },
        { kind: 'tool-call', callId: 'j2', name: 'edit', argsRaw: JSON.stringify(editTwo) },
        { kind: 'tool-call', callId: 'j3', name: 'edit', argsRaw: JSON.stringify(editThree) },
        { kind: 'tool-call', callId: 'j4', name: 'write', argsRaw: JSON.stringify(writeNew) },
      ],
    },
  }
  const settled = (seq, callId, args) => ({
    kind: 'tool-call',
    data: { root: { kind: 'tool-result', seq, callId, call: { name: 'edit', argsRaw: JSON.stringify(args) }, content: [], isError: false, subCalls: [] } },
  })

  const { wait: waitOne, respondResults: respondsOne } = approvalWait('s1', 'a:b1', 'apb1', { toolName: 'edit', callId: 'j1', reason: 'one' })
  const { wait: waitTwo, respondResults: respondsTwo } = approvalWait('s1', 'a:b2', 'apb2', { toolName: 'edit', callId: 'j2', reason: 'two' })
  const { wait: waitThree, respondResults: respondsThree } = approvalWait('s1', 'a:b3', 'apb3', { toolName: 'edit', callId: 'j3', reason: 'three' })
  const { wait: waitFour, respondResults: respondsFour } = approvalWait('s1', 'a:b4', 'apb4', { toolName: 'write', callId: 'j4', reason: 'four' })
  const kit = mkSessionKit('s1', {
    pending: [waitOne],
    runningCalls: [runningCall('j1', 'edit', editOne)],
    chat: { nodes: { values: () => [stepNode] } },
  }, '/w')
  const disk = installDisk({ '/w/big.md': bigLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(waitOne)))
    await flushMicrotasks()
    tree = React.rerender()

    // PER-FILE scope: Allow on the big.md tab decides THAT FILE only — j1
    // answers now, j2/j3 arm; the write (j4, other file) is untouched.
    buttonByText(tree, 'Allow').props.onClick()
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsOne.map((result) => result.value.outcome), ['allowed-once'],
      'the live approval answered immediately')
    assert.ok(collectElements(tree).some((node) => textOf(node).includes('2 queued accepts')),
      'queued-accepts pill shows THIS FILE\'s 2 pre-decisions (not the write)')
    assert.deepEqual(respondsFour.map((result) => result.value.outcome), [],
      'the OTHER file\'s request was not decided from this tab')

    // j1 settles; j2's approval frame arrives -> AUTO-delivered, no click.
    kit.setSnapshot({
      pending: [waitTwo],
      runningCalls: [runningCall('j2', 'edit', editTwo)],
      chat: { nodes: { values: () => [stepNode, settled(61, 'j1', editOne)] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitTwo)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsTwo.map((result) => result.value.outcome), ['allowed-once'],
      'the queued approval was answered AUTOMATICALLY on arrival (exact wire value)')
    assert.ok(collectElements(tree).some((node) => textOf(node).includes('1 queued accept')),
      'queued-accept count drops as decisions deliver')
    assert.ok(respondsTwo[0].value.approvalId === 'apb2', 'auto-delivery used the live approvalId')
    ok('per-file decide: one click per FILE; queued asks auto-answered on arrival with the exact wire value')

    // Cancel: the remaining queued pre-decisions are withdrawn.
    const cancelButton = collectElements(tree)
      .find((node) => node.props && node.props['aria-label'] === 'Cancel the queued accepts not yet delivered')
    cancelButton.props.onClick()
    tree = React.rerender()
    assert.ok(!collectElements(tree).some((node) => /queued accept/.test(textOf(node))),
      'queued-accept pill leaves after cancellation')

    // j3's frame arrives -> NOT auto-answered; manual decision still works.
    kit.setSnapshot({
      pending: [waitThree],
      runningCalls: [runningCall('j3', 'edit', editThree)],
      chat: { nodes: { values: () => [stepNode, settled(61, 'j1', editOne), settled(62, 'j2', editTwo)] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitThree)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.deepEqual(respondsThree.map((result) => result.value.outcome), [],
      'after cancellation, the arriving approval is NOT auto-answered')
    assert.notEqual(buttonByText(tree, 'Allow').props.disabled, true, 'manual decision available')
    buttonByText(tree, 'Reject').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsThree.map((result) => result.value.outcome), ['rejected'], 'manual decision delivered')
    ok('cancel withdraws undelivered pre-decisions; manual decisions still work')

    // j4's turn: the card auto-advanced to the new.md tab; its own Allow.
    kit.setSnapshot({
      pending: [waitFour],
      runningCalls: [runningCall('j4', 'write', writeNew)],
      chat: { nodes: { values: () => [stepNode, settled(61, 'j1', editOne), settled(62, 'j2', editTwo), settled(63, 'j3', editThree)] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitFour)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.match(firstByClass(tree, 'adf-head-file').props.title, /new\.md/, 'card advanced to the write\'s file')
    buttonByText(tree, 'Allow').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsFour.map((result) => result.value.outcome), ['allowed-once'],
      'the write decided on ITS tab with the same two buttons')
    ok('each file decided on its own tab with the same two buttons')
  } finally {
    disk.restore()
  }
}

// --- Scenario J: stale-cache, CRLF, and honest unanchored numbering ---------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  // 1) STALE CACHE: a SECOND sequential edit to the same file (new approval
  //    key) must re-read the disk — the cached pre-first-edit copy once left
  //    the second edit unanchored (found in the wild).
  const fileV1 = ['v1 line one', 'v1 line two', 'v1 line three']
  const fileV2 = ['v2 line one', 'v2 line two', 'v2 line three']
  const editA = { file_path: '/w/seq.md', old_string: 'v1 line one', new_string: 'v2 line one' }
  const editB = { file_path: '/w/seq.md', old_string: 'v2 line two', new_string: 'v2 line TWO' }
  const { wait: waitA } = approvalWait('s1', 'a:s1', 'aps1', { toolName: 'edit', callId: 'sa', reason: 'a' })
  const { wait: waitB } = approvalWait('s1', 'a:s2', 'aps2', { toolName: 'edit', callId: 'sb', reason: 'b' })
  const kit = mkSessionKit('s1', snapshotOf([waitA], [runningCall('sa', 'edit', editA)]), '/w')
  let diskFiles = { '/w/seq.md': fileV1.join('\n') + '\n' }
  const disk = installDisk(new Proxy({}, {
    get: (target, prop) => diskFiles[prop],
  }))
  // Simpler: installDisk takes a plain object; mutate it between phases.
  disk.restore()
  const mutableFiles = {}
  const disk2 = {
    requestedPaths: [],
    restore() { delete globalThis.fetch },
  }
  globalThis.fetch = (url) => {
    if (String(url).includes('/approval-diff/observed')) {
      // Observed-mirror queries are not file reads — answer untracked so no
      // prediction fires in this scenario (it tests the context cache).
      return Promise.resolve({ ok: true, json: async () => ({ observed: false, kind: null, tracked: false }) })
    }
    const requestedPath = decodeURIComponent(String(url).split('path=')[1])
    disk2.requestedPaths.push(requestedPath)
    const content = mutableFiles[requestedPath]
    if (content === undefined) return Promise.resolve({ ok: false, json: async () => ({ error: 'not found' }) })
    return Promise.resolve({ ok: true, json: async () => ({ path: requestedPath, content, truncated: false }) })
  }
  try {
    mutableFiles['/w/seq.md'] = fileV1.join('\n') + '\n'
    let tree = React.mount(React.createElement(component, kit.propsFor(waitA)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.ok(disk2.requestedPaths.filter((p) => p === '/w/seq.md').length === 1,
      'first approval reads the file once')

    // First edit applied; disk is now V2. The SECOND approval must re-read.
    mutableFiles['/w/seq.md'] = fileV2.join('\n') + '\n'
    kit.setSnapshot(snapshotOf([waitB], [runningCall('sb', 'edit', editB)]))
    tree = React.mount(React.createElement(component, kit.propsFor(waitB)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.equal(disk2.requestedPaths.filter((p) => p === '/w/seq.md').length, 2,
      'a NEW approval for the same path re-reads the disk (no stale cache)')
    // And the second edit ANCHORS against V2 (true file numbers).
    const cells = gridCellsOf(tree)
    const changedOld = cells.find((cell) => cell.props.style.gridColumn === '1' && textOf(cell) === '2')
    assert.ok(changedOld !== undefined, 'second edit anchored: its row carries the true file number (2)')
    ok('sequential same-file edits re-read the disk; the second edit anchors on fresh content')

    // 2) CRLF: a \r\n file anchors against \n operands.
    mutableFiles['/w/crlf.md'] = 'c1\r\nc2 target\r\nc3\r\n'
    const crlfEdit = { file_path: '/w/crlf.md', old_string: 'c2 target', new_string: 'c2 CHANGED' }
    const { wait: crlfWait } = approvalWait('s1', 'a:cr', 'apcr', { toolName: 'edit', callId: 'cr', reason: 'x' })
    kit.setSnapshot(snapshotOf([crlfWait], [runningCall('cr', 'edit', crlfEdit)]))
    tree = React.mount(React.createElement(component, kit.propsFor(crlfWait)))
    await flushMicrotasks()
    tree = React.rerender()
    const crlfCells = gridCellsOf(tree)
    assert.ok(crlfCells.some((cell) => textOf(cell) === 'c1'),
      'CRLF file: context anchors (line-ending normalized for matching)')
    ok('CRLF files anchor against LF operands')

    // 3) MISSING OPERAND, single pending edit (v0.14.2 law): certain doom —
    //    the card renders NOTHING (no tab, no banner; auto-forward sends it
    //    to the gate's own error). The blank-number rendering for QUEUED
    //    unanchored hunks (operand basis is post-prior-edit) stays covered by
    //    the merged-walk scenarios.
    mutableFiles['/w/other.md'] = 'x1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\n'
    const ghostEdit = { file_path: '/w/other.md', old_string: 'not in file', new_string: 'ghost' }
    const { wait: ghostWait } = approvalWait('s1', 'a:gh', 'apgh', { toolName: 'edit', callId: 'gh', reason: 'g' })
    kit.setSnapshot(snapshotOf([ghostWait], [runningCall('gh', 'edit', ghostEdit)]))
    tree = React.mount(React.createElement(component, kit.propsFor(ghostWait)))
    await flushMicrotasks()
    tree = React.rerender()
    await flushMicrotasks()
    tree = React.rerender()
    assert.equal(tree, null, 'missing-operand pending edit: NOTHING renders (invisible doom)')
    ok('missing operand: invisible — no card, no tab, no banner (forwarded to the gate)')
  } finally {
    disk2.restore()
  }
}

// --- Scenario K: Split / Unified toggle (v0.12) -------------------------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  const fileLines = ['c01', 'old line', 'c03', 'another old', 'c05', 'c06', 'c07']
  const editArgs = {
    file_path: '/w/toggle.md',
    old_string: 'old line\nc03\nanother old',
    new_string: 'old line CHANGED\nNEW middle\nanother old',
  }
  const { wait: toggleWait } = approvalWait('s1', 'a:t1', 'apt1', { toolName: 'edit', callId: 't1', reason: 't' })
  const kit = mkSessionKit('s1', snapshotOf([toggleWait], [runningCall('t1', 'edit', editArgs)]), '/w')
  const disk = installDisk({ '/w/toggle.md': fileLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(toggleWait)))
    await flushMicrotasks()
    tree = React.rerender()

    // Toggle exists on edit reviews; default is split (4-column grid).
    const unifiedButton = collectElements(tree)
      .find((node) => node.type === 'button' && textOf(node) === 'Unified')
    assert.ok(unifiedButton !== undefined, 'the Unified toggle renders for edits')
    assert.ok(firstByClass(tree, 'adf-grid').props.className.includes('adf-grid-twoside'),
      'default view is split')

    // Switch to unified: one content column, sign gutter, grouped change runs.
    unifiedButton.props.onClick()
    tree = React.rerender()
    const grid = firstByClass(tree, 'adf-grid')
    assert.ok(grid.props.className.includes('adf-grid-unified'), 'grid switches to unified')
    const cells = gridCellsOf(tree)
    assert.ok(cells.some((cell) => String(cell.props.className).split(/\s+/).includes('adf-sign')
      && textOf(cell) === '-'), 'a minus-sign row marker renders')
    assert.ok(cells.some((cell) => String(cell.props.className).split(/\s+/).includes('adf-sign')
      && textOf(cell) === '+'), 'a plus-sign row marker renders')
    // GROUPING (manual-testing feedback): within a contiguous change run, ALL
    // '-' rows come before ALL '+' rows (GitHub hunk semantics).
    const rowOfSign = (sign) => cells
      .filter((cell) => String(cell.props.className).split(/\s+/).includes('adf-sign') && textOf(cell) === sign)
      .map((cell) => Number(cell.props.style.gridRow))
    const minusRows = rowOfSign('-')
    const plusRows = rowOfSign('+')
    assert.ok(minusRows.length > 0 && plusRows.length > 0, 'both signs present')
    assert.ok(Math.max(...minusRows) < Math.min(...plusRows),
      'all - rows above all + rows within the change run (grouped, not interleaved)')
    const insertedCell = cells.find((cell) => textOf(cell) === 'NEW middle')
    assert.ok(insertedCell !== undefined && String(insertedCell.props.className).includes('adf-add'),
      'inserted line green in unified')
    const contextCell = cells.find((cell) => textOf(cell) === 'c01')
    assert.ok(contextCell !== undefined && String(contextCell.props.className).includes('adf-ctx'),
      'context neutral in unified')
    // Split toggle returns the two-column layout.
    collectElements(tree).find((node) => node.type === 'button' && textOf(node) === 'Split').props.onClick()
    tree = React.rerender()
    assert.ok(firstByClass(tree, 'adf-grid').props.className.includes('adf-grid-twoside'),
      'toggle back to split')
    ok('split/unified toggle: default split; unified = one column with -/+ markers; toggle back')

    // One-sided layouts (write) show NO toggle — inherently single-column.
    const { wait: writeWait } = approvalWait('s1', 'a:t2', 'apt2', { toolName: 'write', callId: 't2', reason: 'w' })
    kit.setSnapshot(snapshotOf([writeWait], [runningCall('t2', 'write', { file_path: '/w/fresh.md', content: 'a\nb\n' })]))
    tree = React.mount(React.createElement(component, kit.propsFor(writeWait)))
    assert.ok(!collectElements(tree).some((node) => node.type === 'button'
      && (textOf(node) === 'Unified' || textOf(node) === 'Split')),
      'write reviews carry no view toggle (unified by nature)')
    ok('one-sided reviews (write/deletion) stay single-mode — no toggle shown')
  } finally {
    disk.restore()
  }
}

// --- Scenario L: pre-approval success check (v0.13) ---------------------------

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  const mkTree = async (editArgs, diskContent, observationNodes, keySuffix) => {
    const { wait, respondResults } = approvalWait('s1', 'a:p1' + keySuffix, 'app1' + keySuffix, { toolName: 'edit', callId: 'p1' + keySuffix, reason: 'x' })
    const kit = mkSessionKit('s1',
      snapshotOf([wait], [runningCall('p1' + keySuffix, 'edit', editArgs)]), '/w')
    kit.holder.snapshot.chat = { nodes: { values: () => observationNodes } }
    const disk = installDisk({ '/w/pre.md': diskContent })
    try {
      let tree = React.mount(React.createElement(component, kit.propsFor(wait)))
      await flushMicrotasks()
      tree = React.rerender()
      await flushMicrotasks()
      tree = React.rerender()
      return { tree, respondResults }
    } finally {
      disk.restore()
    }
  }
  const allowButton = (tree) => collectElements(tree)
    .filter((node) => node.type === 'button' && textOf(node) === 'Allow')[0]
  const rejectButton = (tree) => collectElements(tree)
    .filter((node) => node.type === 'button' && textOf(node) === 'Reject')[0]
  const readNode = (seq, text) => completedCallNode(seq, 'read', { file_path: '/w/pre.md' },
    [{ type: 'text', text }])
  const writeNode = (seq, content) => completedCallNode(seq, 'write', { file_path: '/w/pre.md', content })

  // 1) THE REGRESSION (v0.13.0 in the wild): a READ whose rendered output
  //    differs from disk must NOT block — read output (gutters/windows/
  //    framing) is not the raw file, and v0.13.0's comparison disabled Allow
  //    permanently. Reads produce NO stale verdict and NO auto-forward.
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'fresh line', new_string: 'edited' },
      'fresh line\nother\n',
      [readNode(30, '     1→stale line\n     2→other\n')],
      'readnosound',
    )
    assert.equal(countByClass(tree, 'adf-precheck-block'), 0, 'read-based staleness: NO blocking banner')
    assert.notEqual(allowButton(tree).props.disabled, true, 'read-based staleness: Allow enabled')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), [],
      'read-based staleness: nothing auto-answered')
    ok('REGRESSION pinned: a differing read output never blocks nor auto-forwards')
  }

  // 2) SOUND stale: the LATEST observation is a WRITE whose exact content
  //    differs from disk → the doomed call is quietly ALLOWED (the harness's
  //    own gate will fail it before any mutation — the model reads the real
  //    system error and re-reads), with the banner narrating the forward.
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'fresh line', new_string: 'edited' },
      'fresh line\nother\n',
      [writeNode(30, 'stale line\nother\n')],
      'wstale',
    )
    assert.equal(tree, null, 'write-stale: NOTHING renders (invisible doom)')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), ['allowed-once'],
      'write-stale: doomed call AUTO-FORWARDED — no user click spent, no card shown')
    ok('sound staleness (write basis): invisible + auto-forwarded')
  }

  // 2b) A later EDIT supersedes the write basis → no stale verdict (the
  //     write's content is outdated by our own edit, not by an outsider).
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'fresh line', new_string: 'edited' },
      'fresh line\nother\n',
      [writeNode(30, 'stale line\nother\n'),
        completedCallNode(31, 'edit', { file_path: '/w/pre.md', old_string: 'x', new_string: 'y' })],
      'wthenedit',
    )
    assert.equal(countByClass(tree, 'adf-precheck-block'), 0, 'write superseded by edit: no stale banner')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), [],
      'no auto-forward when the basis is our own edit')
    ok('a later edit invalidates the write basis (no false stale, no forward)')
  }

  // 3) MISSING operand: old_string absent from disk → auto-forwarded (the
  //    edit will fail its operand match before any mutation).
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'not in the file', new_string: 'x' },
      'alpha\nbeta\n',
      [readNode(30, '     1→alpha\n     2→beta\n')],
      'missing',
    )
    assert.equal(tree, null, 'missing: NOTHING renders (invisible doom)')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), ['allowed-once'],
      'missing operand: auto-forwarded')
    ok('missing operand: invisible + auto-forwarded (certain failure)')
  }

  // 4) AMBIGUOUS: two occurrences without replace_all → auto-forwarded.
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'dup', new_string: 'once' },
      'dup\nmiddle\ndup\n',
      [readNode(30, '     1→dup\n     2→middle\n     3→dup\n')],
      'ambig',
    )
    assert.equal(tree, null, 'ambiguous: NOTHING renders (invisible doom)')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), ['allowed-once'],
      'ambiguous operand: auto-forwarded')
    ok('ambiguous operand (2 occurrences, no replace_all): invisible + auto-forwarded')
  }

  // 4b) replace_all with two occurrences → NOT blocked, NOT forwarded.
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'dup', new_string: 'once', replace_all: true },
      'dup\nmiddle\ndup\n',
      [readNode(30, '     1→dup\n     2→middle\n     3→dup\n')],
      'ra',
    )
    assert.equal(countByClass(tree, 'adf-precheck-block'), 0, 'replace_all tolerates multiple occurrences')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), [], 'replace_all: nothing forwarded')
    ok('replace_all with duplicates: no block, no forward')
  }

  // 5) HEALTHY: write basis matches disk, operand present exactly once.
  {
    const { tree, respondResults } = await mkTree(
      { file_path: '/w/pre.md', old_string: 'alpha', new_string: 'ALPHA' },
      'alpha\nbeta\n',
      [writeNode(30, 'alpha\nbeta\n')],
      'ok',
    )
    assert.equal(countByClass(tree, 'adf-precheck-block'), 0, 'healthy: no blocking banner')
    assert.equal(countByClass(tree, 'adf-precheck-warn'), 0, 'healthy: no warning either')
    assert.notEqual(allowButton(tree).props.disabled, true, 'healthy: Allow enabled')
    assert.deepEqual(respondResults.map((result) => result.value.outcome), [],
      'healthy: the decision stays with the operator')
    ok('healthy edit: no banners, no auto-forward, Allow enabled')
  }

  // 6) WINDOW-BLIND (v0.15): no observation in the window is SILENT now —
  //    approval-first probes the gate before asking, so an edit ask that
  //    reaches a card has already passed it; the never-observed prediction
  //    layer (host mirror) is gone as wrong-layer duplication.
  {
    const { wait, respondResults } = approvalWait('s1', 'a:p2', 'app2', { toolName: 'edit', callId: 'p2', reason: 'x' })
    const kit = mkSessionKit('s1',
      snapshotOf([wait], [runningCall('p2', 'edit', { file_path: '/w/unread.md', old_string: 'a', new_string: 'b' })]), '/w')
    const disk = installDisk({ '/w/unread.md': 'a\nb\n' })
    try {
      let tree = React.mount(React.createElement(component, kit.propsFor(wait)))
      await flushMicrotasks()
      tree = React.rerender()
      assert.equal(countByClass(tree, 'adf-precheck-warn'), 0, 'window-blind: SILENT (the ask itself proves the gate passed)')
      assert.equal(countByClass(tree, 'adf-precheck-block'), 0, 'window-blind: no block')
      assert.notEqual(allowButton(tree).props.disabled, true, 'window-blind: Allow enabled')
      assert.deepEqual(respondResults.map((result) => result.value.outcome), [],
        'window-blind: nothing forwarded')
      ok('window-blind is silent (v0.15): prediction of observation moved to approval-first, at the source')
    } finally {
      disk.restore()
    }
  }
}

// --- Scenario O: an rm of the SAME file never joins the edit run (v0.17.1) ---
// Live shape found in manual testing: [edit f, edit f, rm f] in one step —
// the rm passed the same-FILE check, joined the tab, and the card's
// deletion-precedence repainted the whole edit review all-red. The run is
// same-file AND same-KIND now; the rm gets its own card at its own turn.

{
  const React = mkMiniReact()
  const plugin = loadClientPlugin(React)
  globalThis.document = mkFakeDocument()
  const slots = mkFakeSlots()
  plugin.apply(mkCtx(plugin.inject, { slots }))
  const component = slots.registrations[0].component

  const fileLines = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8']
  const editOne = { file_path: '/w/same.md', old_string: 'o2', new_string: 'o2 ONE' }
  const editTwo = { file_path: '/w/same.md', old_string: 'o6', new_string: 'o6 TWO' }
  const rmCall = { command: 'rm /w/same.md' }
  const stepNode = { kind: 'assistant-step', anchorSeq: 80, data: { status: 'settled', turn: 1, step: 1, time: 0, blocks: [
    { kind: 'tool-call', callId: 'o1c', name: 'edit', argsRaw: JSON.stringify(editOne) },
    { kind: 'tool-call', callId: 'o2c', name: 'edit', argsRaw: JSON.stringify(editTwo) },
    { kind: 'tool-call', callId: 'o3c', name: 'bash', argsRaw: JSON.stringify(rmCall) },
  ] } }
  const { wait: waitOne } = approvalWait('s1', 'a:o1', 'apo1', { toolName: 'edit', callId: 'o1c', reason: 'one' })
  const kit = mkSessionKit('s1',
    snapshotOf([waitOne], [runningCall('o1c', 'edit', editOne)]), '/w')
  kit.holder.snapshot.chat = { nodes: { values: () => [stepNode] } }
  const disk = installDisk({ '/w/same.md': fileLines.join('\n') + '\n' })
  try {
    let tree = React.mount(React.createElement(component, kit.propsFor(waitOne)))
    await flushMicrotasks()
    tree = React.rerender()

    // THE REGRESSION: the card stays an EDIT review (hunks present, red/green
    // grid), not the all-red deletion view the rm's precedence would paint.
    assert.equal(firstByClass(tree, 'adf-composer').props['data-hunk-count'], '2',
      'both edit hunks render (the queued same-file edit joined the run)')
    assert.equal(countByClass(tree, 'adf-path'), 0,
      'NO deletion path rows — the rm did NOT flip the card into deletion view')
    assert.ok(!collectElements(tree).some((node) => textOf(node).includes('(deleted)')),
      'no "(deleted)" marker on an edit review')
    assert.ok(collectElements(tree).some((node) => textOf(node) === 'o2 ONE'),
      'edit hunk one renders')
    assert.ok(collectElements(tree).some((node) => textOf(node) === 'o6 TWO'),
      'edit hunk two renders (queued sibling merged)')
    ok('REGRESSION pinned: rm of the same file never joins the edit run — the card stays a diff')

    // The rm's OWN turn: its own card, the honest all-red deletion review.
    const { wait: waitRm, respondResults: respondsRm } = approvalWait('s1', 'a:o3', 'apo3', { toolName: 'bash', callId: 'o3c', reason: 'rm' })
    kit.setSnapshot({
      pending: [waitRm],
      runningCalls: [runningCall('o3c', 'bash', rmCall)],
      chat: { nodes: { values: () => [stepNode, settledToolCall('o1c'), settledToolCall('o2c')] } },
    })
    tree = React.mount(React.createElement(component, kit.propsFor(waitRm)))
    await flushMicrotasks()
    tree = React.rerender()
    assert.ok(collectElements(tree).some((node) => textOf(node).includes('(deleted)')),
      'the rm renders its own deletion review at its turn')
    firstByClass(tree, 'adf-btn-reject').props.onClick()
    await flushMicrotasks()
    assert.deepEqual(respondsRm.map((result) => result.value.outcome), ['rejected'],
      'the deletion decided on its own card')
    ok('the rm gets its own card and decision at its own turn')
  } finally {
    disk.restore()
  }
}

console.log('\nall green: ' + checks + ' checks')
