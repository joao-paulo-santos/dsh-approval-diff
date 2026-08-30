/**
 * dsh-approval-diff — client bundle tests against faithful fakes (v0.21).
 *
 * The plugin is now a NATIVE-CARD DETAIL: it registers the
 * `conversation.approval.detail` seat and renders the pending file mutation
 * as a diff (disk-anchored when /approval-diff/context answers, operand-
 * aligned with blank numbers otherwise). The composer takeover, wait
 * plumbing, and batch answers are gone with the old interaction model.
 *
 * Run: node test/client.test.mjs   (exit 0 = all assertions green)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = pathDirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE_PATH = pathResolve(HERE, '../lib/client.js')
const DIFF_VIEW_BUNDLE_PATH = pathResolve(HERE, '../../dsh-diff-view/lib/client.js')

const mkDocument = () => {
  const head = { children: [] }
  head.appendChild = (tag) => { head.children.push(tag) }
  return {
    head,
    createElement: (tagName) => {
      const tag = { tagName, dataset: {}, textContent: '' }
      tag.remove = () => { const at = head.children.indexOf(tag); if (at >= 0) head.children.splice(at, 1) }
      return tag
    },
  }
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return (node.children ?? []).map(textOf).join('')
}
const firstByClass = (node, cls) => flatten(node).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))

const savedFetch = globalThis.fetch

/** Load both bundles; apply the plugin; return a hook-aware render harness. */
const loadDetail = () => {
  const seen = []
  let hookIdx = 0
  const slots = []
  const effects = []
  const react = {
    createElement: (type, props, ...children) => {
      const el = { type, props, children: children.flat(Infinity) }
      seen.push(el)
      return el
    },
    Fragment: 'FRAGMENT',
    useState: (init) => {
      const i = hookIdx++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  const provided = {}
  const registrations = []
  const queueRegistrations = { events: [], views: [] }
  globalThis.window = { __ModuleLoader__: { load: (h) => { registrations.push(h) } } }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(DIFF_VIEW_BUNDLE_PATH, 'utf8'))
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  delete globalThis.window
  const requireOf = (spec) => {
    if (spec === 'react') return react
    throw new Error('unexpected require: ' + spec)
  }
  const diffModule = registrations.find((r) => r.id === 'dsh-diff-view').factory(requireOf)
  diffModule.apply({ inject: [], get: () => undefined, provide: (n, a) => { provided[n] = a }, on: () => () => {} })
  const plugin = registrations.find((r) => r.id === 'dsh-approval-diff').factory(requireOf)
  const registered = []
  const uiConversation = {
    events: { register: (d) => { queueRegistrations.events.push(d); return () => {} } },
    views: { register: (d) => { queueRegistrations.views.push(d); return () => {} } },
  }
  const dispose = plugin.apply({
    inject: plugin.inject,
    slots: {
      inject: (seat, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component }); return component },
    },
    diffView: provided.diffView,
    uiConversation,
    get: (n) => (n === 'diffView' ? provided.diffView : undefined),
    provide: () => {},
    on: () => () => {},
  })
  const Detail = registered[0].component
  const nextRender = () => { hookIdx = 0; effects.length = 0 }
  const runEffects = async () => { for (const fn of effects.splice(0)) { const r = fn(); if (r && typeof r.then === 'function') await r } }
  const render = (props) => { nextRender(); return Detail(props) }
  const settle = async (props) => {
    let tree = render(props)
    for (let i = 0; i < 4; i++) { await runEffects(); await new Promise((r) => setTimeout(r, 2)); tree = render(props) }
    return tree
  }
  return {
    Detail, registered, seen, dispose, nextRender, runEffects, render, settle, queueRegistrations,
    setFetch: (fn) => { globalThis.fetch = fn },
    restoreFetch: () => { globalThis.fetch = savedFetch },
  }
}

const withCallId = (nodes, callId) => { nodes.callId = callId; return nodes }
const mkProps = (chatNodes, callId, { byId = {}, pendingMap = new Map(), queue = { asks: [] }, viewMode } = {}) => ({
  callId,
  viewMode,
  bumpQueue: () => {},
  useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? { nodes: { values: () => chatNodes } } : (t === 'approval-diff-queue' ? queue : undefined)) } }),
  useSessions: (sel) => sel({ byId }),
  useSession: (sel) => sel({ sessionId: 's1' }),
  useSessionPendingInteraction: (sel) => sel(pendingMap),
})
const editNodes = (callId, oldString, newString) => withCallId([{
  kind: 'assistant-step',
  data: { blocks: [{ kind: 'tool-call', callId, name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: oldString, new_string: newString }) }] },
}], callId)

const numsOf = (tree, side) => flatten(tree)
  .filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('adf-num')
    && n.props.style?.gridColumn === (side === 'left' ? '1' : '3'))
  .map(textOf)
const hasClass = (tree, cls) => flatten(tree).some((n) => typeof n.props?.className === 'string' && n.props.className.includes(cls))

test('registers the conversation.approval.detail seat at priority -1; dispose unregisters', () => {
  const env = loadDetail()
  assert.equal(env.registered.length, 1)
  assert.equal(env.registered[0].options.name, 'conversation.approval.detail')
  assert.equal(env.registered[0].options.priority, -1, 'shadows the chat view default detail (lowest renders)')
  assert.equal(typeof env.registered[0].component, 'function')
  env.dispose()
})

test('unified: edit renders dels/adds with blank numbers when disk is unavailable', async () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  const tree = await env.settle(mkProps(editNodes('call-1', 'const a = 1;', 'const b = 2;'), 'call-1', { viewMode: 'unified' }))
  assert.ok(hasClass(tree, 'adf-del') && hasClass(tree, 'adf-add'), 'change rows rendered')
  const nums = numsOf(tree, 'left')
  assert.ok(nums.every((t) => t === ''), 'blank numbers in the fallback')
  assert.ok(hasClass(tree, 'adf-viewtoggle'), 'split/unified toggle present')
  env.restoreFetch()
})

test('unified: disk truth anchors numbers, word highlights, collapse window', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['l1', 'l2', 'l3', 'l4', 'l5', 'OLD A', 'OLD B', 'l8', 'l9', 'l10'].join('\n'), truncated: false }) }))
  const tree = await env.settle(mkProps(editNodes('call-9', 'OLD A\nOLD B', 'NEW A\nNEW B'), 'call-9', { byId: { s1: { cwd: '/w' } }, viewMode: 'unified' }))
  // unified: del rows carry disk numbers, add rows carry new-file numbers
  const actualNums = numsOf(tree, 'left')
  assert.deepEqual(actualNums, ['3', '4', '5', '6', '7', '6', '7', '8', '9', '10'])
  assert.ok(hasClass(tree, 'adf-ellipsis'), 'middle collapsed')
  env.restoreFetch()
})

test('split: both sides carry numbers, pairs word-highlighted', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['l1', 'l2', 'l3', 'OLD A', 'NEW B', 'l6'].join('\n'), truncated: false }) }))
  // first render sets the remembered mode; flip to split via the toggle button
  let tree = await env.settle(mkProps(editNodes('call-5', 'OLD A', 'NEW A\nNEW B'), 'call-5', { byId: { s1: { cwd: '/w' } } }))
  const toggle = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Split')
  toggle.props.onClick()
  tree = env.render(mkProps(editNodes('call-5', 'OLD A', 'NEW A\nNEW B'), 'call-5', { byId: { s1: { cwd: '/w' } } }))
  assert.ok(hasClass(tree, 'adf-grid-twoside'), 'split grid rendered')
  const left = numsOf(tree, 'left')
  const right = numsOf(tree, 'right')
  assert.equal(left.length, right.length, 'paired rows')
  assert.ok(hasClass(tree, 'adf-w-del') || hasClass(tree, 'adf-w-add'), 'word highlights present')
})

test('arming: answers the current request allowed-once and later same-file requests', async () => {
  const env = loadDetail()
  const answered = []
  const mkPending = (key) => ({ kind: 'approval', key, callId: 'call-1', answer: async (outcome) => { answered.push({ key, outcome }) } })
  const pendingMap = new Map([['s1', mkPending('k1')]])
  const byId = { s1: { cwd: '/w' } }
  const nodes = editNodes('call-1', 'const a = 1;', 'const b = 2;')

  const props = () => mkProps(nodes, 'call-1', { byId, pendingMap })
  let tree = await env.settle(props())
  const armButton = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Auto-allow edits to this file')
  assert.ok(armButton !== undefined, 'arm control rendered')
  armButton.props.onClick()                      // the user arms the file
  tree = env.render(props())                     // re-render records the effect
  await env.runEffects()
  assert.deepEqual(answered, [{ key: 'k1', outcome: 'allowed-once' }], 'current request auto-answered')

  // a LATER same-file request (new key) is auto-answered without the user
  pendingMap.set('s1', mkPending('k2'))
  tree = await env.settle(props())
  assert.deepEqual(answered, [
    { key: 'k1', outcome: 'allowed-once' },
    { key: 'k2', outcome: 'allowed-once' },
  ], 'sequential same-file request auto-answered (armed)')
  assert.ok(hasClass(tree, 'adf-detail-armed'), 'armed state visible')

  // disarm stops the automation
  const disarm = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'disarm')
  disarm.props.onClick()
  pendingMap.set('s1', mkPending('k3'))
  tree = await env.settle(props())
  assert.equal(answered.length, 2, 'disarmed: no further auto-answers')
  assert.ok(!hasClass(tree, 'adf-detail-armed'), 'armed banner gone')
})

test('stale operand warns instead of lying', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: 'something\nelse', truncated: false }) }))
  const tree = await env.settle(mkProps(editNodes('call-7', 'NOT ON DISK', 'NEW'), 'call-7', { byId: { s1: { cwd: '/w' } } }))
  assert.match(textOf(tree), /stale read/, 'stale-operand warning rendered')
  env.restoreFetch()
})

test('non-file tools and unparseable args render nothing', async () => {
  const env = loadDetail()
  const readTree = await env.settle(mkProps(withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'c', name: 'read', argsRaw: '{}' }] } }], 'c'), 'c'))
  assert.equal(readTree, null)
  const badTree = await env.settle(mkProps(withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'c', name: 'edit', argsRaw: '{not json' }] } }], 'c'), 'c'))
  assert.equal(badTree, null)
})

test('delete command shows the review notice', async () => {
  const env = loadDetail()
  const tree = await env.settle(mkProps(withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: JSON.stringify({ command: 'rm -rf build/' }) }] } }], 'c'), 'c'))
  assert.match(textOf(tree), /deletes files/)
})


test('queue view: event + view definitions registered on uiConversation', () => {
  const env = loadDetail()
  assert.equal(env.queueRegistrations.events.length, 1)
  assert.equal(env.queueRegistrations.events[0].kind, 'approval-diff-queue')
  assert.equal(env.queueRegistrations.views.length, 1)
  assert.equal(env.queueRegistrations.views[0].target, 'approval-diff-queue')
  env.dispose()
})

test('queue view: asked starts, decided updates, builder aggregates', () => {
  const env = loadDetail()
  const def = env.queueRegistrations.events[0]
  const asked = { type: 'approval/asked', data: { id: 'q1', toolName: 'edit', callId: 'call-1' } }
  const decided = { type: 'approval/decided', data: { id: 'q1', outcome: 'allowed-once' } }
  assert.deepEqual(def.match(asked), { id: 'q1', role: 'start' })
  assert.deepEqual(def.match(decided), { id: 'q1', role: 'update' })
  assert.equal(def.match({ type: 'step/end', data: {} }), null)
  const ctxStart = { key: 'k', state: undefined }
  const state = def.start(ctxStart, { event: asked, role: 'start', location: {} })
  assert.equal(state.callId, 'call-1')
  const state2 = def.update({ key: 'k', state }, { event: decided, role: 'update', location: {} })
  assert.equal(state2.decided, 'allowed-once')
  const node = def.buildViewNode({ key: 'k', state: state2 })
  assert.equal(node.id, 'q1')
  const view = env.queueRegistrations.views[0]
  const builder = view.create()
  const snap = builder.replace({ nodes: [{ id: 'q1', data: state2 }], timeline: { turnOrder: [], turns: new Map() } })
  assert.equal(snap.asks.length, 1)
  const snap2 = builder.apply({ upserts: [{ id: 'q2', data: { id: 'q2', decided: null } }], timeline: { turnOrder: [], turns: new Map() } })
  assert.equal(snap2.asks.length, 2)
})

test('group: queued same-file edit shows count, Allow all answers both', async () => {
  const env = loadDetail()
  const answered = []
  const mkPending = (key) => ({ kind: 'approval', key, callId: key === 'k1' ? 'call-1' : 'call-2', answer: async (outcome) => { answered.push({ key, outcome }) } })
  const pendingMap = new Map([['s1', mkPending('k1')]])
  const byId = { s1: { cwd: '/w' } }
  const nodes = [
    { kind: 'assistant-step', data: { blocks: [
      { kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A', new_string: 'NEW A' }) },
      { kind: 'tool-call', callId: 'call-2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD B', new_string: 'NEW B' }) },
    ] } },
  ]
  const queue = { asks: [
    { id: 'q1', callId: 'call-1', decided: null },
    { id: 'q2', callId: 'call-2', decided: null },
  ] }
  const props = mkProps(nodes, 'call-1', { byId, pendingMap, queue })
  let tree = await env.settle(props)
  assert.match(textOf(tree), /1 more edit queued for this file/)
  const allowAll = flatten(tree).find((n) => n.type === 'button' && textOf(n).startsWith('Allow all'))
  assert.ok(allowAll !== undefined, 'Allow all button rendered')
  allowAll.props.onClick()
  tree = env.render(props)
  await env.runEffects()
  tree = env.render(props)
  assert.deepEqual(answered, [{ key: 'k1', outcome: 'allowed-once' }], 'current answered by the group decision')
  // the queued request becomes effective with a new key: same file, same outcome
  pendingMap.set('s1', mkPending('k2'))
  tree = env.render(props)
  await env.runEffects()
  assert.deepEqual(answered, [
    { key: 'k1', outcome: 'allowed-once' },
    { key: 'k2', outcome: 'allowed-once' },
  ], 'queued same-file request auto-answered with the group outcome')
})

test('merged: two queued edits to one file render both regions against disk', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['top', 'OLD A', 'mid', 'OLD B', 'bottom'].join('\n'), truncated: false }) }))
  const nodes = [
    { kind: 'assistant-step', data: { blocks: [
      { kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A', new_string: 'NEW A' }) },
      { kind: 'tool-call', callId: 'call-2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD B', new_string: 'NEW B' }) },
    ] } },
  ]
  const queue = { asks: [
    { id: 'q1', callId: 'call-1', decided: null },
    { id: 'q2', callId: 'call-2', decided: null },
  ] }
  const props = mkProps(nodes, 'call-1', { byId: { s1: { cwd: '/w' } }, queue })
  const tree = await env.settle(props)
  const texts = flatten(tree).map(textOf)
  assert.ok(texts.some((t) => t === 'NEW A'), 'first edit rendered')
  assert.ok(texts.some((t) => t === 'NEW B'), 'second edit rendered (merged view)')
  assert.ok(texts.some((t) => t === 'mid'), 'intervening disk line kept as context')
})
