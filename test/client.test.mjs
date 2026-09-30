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
const mkProps = (chatNodes, callId, { byId = {}, pendingInteraction = undefined, queue = { asks: [] }, viewMode, sessionId = 's1' } = {}) => ({
  callId,
  viewMode,
  bumpQueue: () => {},
  useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? { nodes: { values: () => chatNodes } } : (t === 'approval-diff-queue' ? queue : undefined)) } }),
  useSessions: (sel) => sel({ byId }),
  useSession: (sel) => sel({ sessionId }),
  // REAL contract: a global-standard hook whose snapshot carries the pending
  // interaction per session. (The old fake fed a useSessionPendingInteraction
  // hook that exists nowhere in the harness — the phantom-passing failure.)
  useSessionStatus: (sel) => sel(new Map([[sessionId, { pendingInteraction }]])),
})
const editNodes = (callId, oldString, newString) => withCallId([{
  kind: 'assistant-step',
  data: { blocks: [{ kind: 'tool-call', callId, name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: oldString, new_string: newString }) }] },
}], callId)

const hasClass = (tree, cls) => flatten(tree).some((n) => typeof n.props?.className === 'string' && n.props.className.includes(cls))
const cellTexts = (tree, cls) => flatten(tree)
  .filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
  .map(textOf)

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
  assert.ok(hasClass(tree, 'ddv-row-del') && hasClass(tree, 'ddv-row-add'), 'change rows rendered')
  const nums = flatten(tree)
    .filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('ddv-num'))
    .map(textOf)
  assert.ok(nums.length > 0)
  assert.ok(nums.every((t) => t === ''), 'blank numbers in the fallback (never lying numbers)')
  assert.ok(hasClass(tree, 'adf-viewtoggle'), 'split/unified toggle present')
  env.restoreFetch()
})

test('unified: disk truth anchors numbers; leading gap collapses into the hunk header', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['l1', 'l2', 'l3', 'l4', 'l5', 'OLD A', 'OLD B', 'l8', 'l9', 'l10'].join('\n'), truncated: false }) }))
  const tree = await env.settle(mkProps(editNodes('call-9', 'OLD A\nOLD B', 'NEW A\nNEW B'), 'call-9', { byId: { s1: { cwd: '/w' } }, viewMode: 'unified' }))
  // One hunk starting 3 lines above the change: @@ -3,8 +3,8 @@
  const headers = cellTexts(tree, 'ddv-hunkheader')
  assert.equal(headers.length, 1)
  assert.match(headers[0], /-3,8 \+3,8/)
  // dels carry disk numbers 6,7; adds carry new-file numbers 6,7.
  const allNums = flatten(tree)
    .filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('ddv-num'))
    .map(textOf)
  assert.deepEqual(allNums.slice(0, 6), ['3', '3', '4', '4', '5', '5'], 'context rows carry old and new disk numbers')
  const delLines = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('ddv-row-del'))
  const addLines = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('ddv-row-add'))
  assert.deepEqual(delLines.map((n) => textOf(n.children[0])), ['6', '7'], 'del rows numbered from disk')
  assert.deepEqual(addLines.map((n) => textOf(n.children[1])), ['6', '7'], 'add rows numbered in the new file')
  assert.deepEqual(delLines.map((n) => textOf(n.children[3])), ['OLD A', 'OLD B'])
  assert.deepEqual(addLines.map((n) => textOf(n.children[3])), ['NEW A', 'NEW B'])
  env.restoreFetch()
})

test('split: both sides carry numbers, pairs word-highlighted', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['l1', 'l2', 'l3', 'OLD A', 'NEW B', 'l6'].join('\n'), truncated: false }) }))
  // first render sets the remembered mode; flip to split via the toggle button
  let tree = await env.settle(mkProps(editNodes('call-5', 'OLD A', 'NEW A\nNEW B'), 'call-5', { byId: { s1: { cwd: '/w' } }, viewMode: 'unified' }))
  const toggle = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Split')
  toggle.props.onClick()
  tree = env.render(mkProps(editNodes('call-5', 'OLD A', 'NEW A\nNEW B'), 'call-5', { byId: { s1: { cwd: '/w' } }, viewMode: 'split' }))
  assert.ok(hasClass(tree, 'ddv-splitline'), 'split rows rendered')
  const splitLines = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('ddv-splitline'))
  assert.ok(splitLines.every((n) => n.children.length === 2), 'paired sides')
  assert.ok(hasClass(tree, 'ddv-w-del') || hasClass(tree, 'ddv-w-add'), 'word highlights present')
})

test('arming: answers the current request allowed-once and later same-file requests', async () => {
  const env = loadDetail()
  const answered = []
  const mkPending = (key) => ({ kind: 'approval', key, callId: 'call-1', answer: async (outcome) => { answered.push({ key, outcome }) } })
  const byId = { s1: { cwd: '/w' } }
  const nodes = editNodes('call-1', 'const a = 1;', 'const b = 2;')

  let current = mkPending('k1')
  const props = () => mkProps(nodes, 'call-1', { byId, pendingInteraction: current })
  let tree = await env.settle(props())
  const armButton = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Auto-allow edits to this file')
  assert.ok(armButton !== undefined, 'arm control rendered')
  armButton.props.onClick()                      // the user arms the file
  tree = env.render(props())                     // re-render records the effect
  await env.runEffects()
  assert.deepEqual(answered, [{ key: 'k1', outcome: 'allowed-once' }], 'current request auto-answered')

  // a LATER same-file request (new key) is auto-answered without the user
  current = mkPending('k2')
  tree = await env.settle(props())
  assert.deepEqual(answered, [
    { key: 'k1', outcome: 'allowed-once' },
    { key: 'k2', outcome: 'allowed-once' },
  ], 'sequential same-file request auto-answered (armed)')
  assert.ok(hasClass(tree, 'adf-detail-armed'), 'armed state visible')

  // disarm stops the automation
  const disarm = flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'disarm')
  disarm.props.onClick()
  current = mkPending('k3')
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


test('group: two pending same-file edits merge into one review', async () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  const nodes = [
    { kind: 'assistant-step', data: { blocks: [
      { kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A', new_string: 'NEW A' }) },
      { kind: 'tool-call', callId: 'call-2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD B', new_string: 'NEW B' }) },
    ] } },
  ]
  const props = mkProps(nodes, 'call-1', { byId: { s1: { cwd: '/w' } }, viewMode: 'unified' })
  const tree = await env.settle(props)
  assert.match(textOf(tree), /2 edits merged/, 'both edits merged into one review')
  assert.ok(hasClass(tree, 'ddv-row-add'), 'add rows rendered')
  assert.ok(hasClass(tree, 'ddv-row-del'), 'del rows rendered')
})

test('group: native decision propagates to later same-file asks', async () => {
  const env = loadDetail()
  const answered = []
  const mkPending = (key, callId) => ({ kind: 'approval', key, callId, answer: async (outcome) => { answered.push({ key, callId, outcome }) } })
  const byId = { s1: { cwd: '/w' } }
  const nodes = [
    { kind: 'assistant-step', data: { blocks: [
      { kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A', new_string: 'NEW A' }) },
      { kind: 'tool-call', callId: 'call-2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD B', new_string: 'NEW B' }) },
    ] } },
  ]

  // Card 1 (call-1): the pending interaction carries the native card's
  // answer as a RESULT PROMISE that resolves after the user clicks.
  let resolveK1
  const k1 = mkPending('k1', 'call-1')
  k1.result = new Promise((resolve) => { resolveK1 = resolve })
  let current = k1
  const propsOf = (callId) => mkProps(nodes, callId, { byId, pendingInteraction: current, viewMode: 'unified' })
  let tree = await env.settle(propsOf('call-1'))
  assert.match(textOf(tree), /NEW A/, 'first edit rendered')

  // THE LIVE FAILURE ORDER (the "asked 3 times" bug): the next ask SURFACES
  // before ask 1's result resolves — the detail has already moved on when
  // the outcome lands. The capture must survive that transition.
  const k2 = mkPending('k2', 'call-2')
  current = k2
  resolveK1('rejected')
  tree = await env.settle(propsOf('call-2'))
  assert.match(textOf(tree), /NEW B/, 'second edit rendered')
  assert.deepEqual(answered, [{ key: 'k2', callId: 'call-2', outcome: 'rejected' }],
    'ask 2 auto-answered with the outcome the user already chose — ONE decision total')

  // Ask 3 of the same group: same propagation, still no new user decision.
  current = mkPending('k3', undefined)
  await env.settle(propsOf('call-2'))
  assert.deepEqual(answered.map((a) => a.outcome), ['rejected', 'rejected'],
    'ask 3 also auto-answered (a 3-edit volley costs the user exactly ONE decision)')
})

test('split regression: class names never render as text (context rows carry the line)', async () => {
  const env = loadDetail()
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['l1', 'l2', 'l3', 'OLD A', 'l5', 'l6'].join('\n'), truncated: false }) }))
  const tree = await env.settle(mkProps(editNodes('call-5', 'OLD A', 'NEW A'), 'call-5', { byId: { s1: { cwd: '/w' } }, viewMode: 'split' }))
  // No cell anywhere renders a literal class name (the old 7-arg push bug).
  const texts = flatten(tree).map(textOf)
  for (const leaked of ['ddv-ctx', 'ddv-add', 'ddv-del', 'ddv-side-ctx', 'ddv-side-add', 'ddv-side-del', 'ddv-srow-ctx', 'ddv-num', 'ddv-text']) {
    assert.ok(!texts.includes(leaked), 'class names must be classNames, never cell text: ' + leaked)
  }
  // Context lines: a real disk line inside ±3 of the change renders as cell
  // CONTENT on BOTH sides (previously the text landed in the number column).
  const ctxSides = flatten(tree).filter((n) => typeof n.props?.className === 'string'
    && n.props.className.split(' ').includes('ddv-text') && textOf(n) === 'l3')
  assert.equal(ctxSides.length, 2, 'left and right context cells carry the real line')
  const ctxNums = flatten(tree)
    .filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('ddv-num'))
    .map(textOf)
  assert.ok(ctxNums.every((t) => t === '' || /^\d+$/.test(t)), 'number columns carry only numbers')
  env.restoreFetch()
})

test('split regression (no disk): operand rows never render class names as text', async () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  const tree = await env.settle(mkProps(editNodes('call-1', 'same\nOLD\nsame', 'same\nNEW\nsame'), 'call-1', { viewMode: 'split' }))
  const texts = flatten(tree).map(textOf)
  for (const leaked of ['ddv-ctx', 'ddv-add', 'ddv-del', 'ddv-side-add', 'ddv-side-del', 'ddv-srow-add', 'ddv-srow-del', 'ddv-num', 'ddv-text']) {
    assert.ok(!texts.includes(leaked), 'unanchored split rows: class names never render as text: ' + leaked)
  }
  assert.ok(texts.includes('same'), 'unchanged operand line renders as content')
  assert.ok(texts.some((t) => t.includes('OLD')), 'removed operand line renders as content')
  assert.ok(texts.some((t) => t.includes('NEW')), 'added operand line renders as content')
  env.restoreFetch()
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

test('merged regression: a size-changing first edit keeps later edits at true disk numbers', async () => {
  const env = loadDetail()
  // Disk: X at line 2, Y at line 7. Edit 1 GROWS the file (1 line -> 3);
  // edit 2's region must still anchor at DISK line 7, not drift.
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: ['top', 'X', 'mid1', 'mid2', 'mid3', 'mid4', 'Y', 'bottom'].join('\n'), truncated: false }) }))
  const nodes = [
    { kind: 'assistant-step', data: { blocks: [
      { kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'X', new_string: 'A1\nA2\nA3' }) },
      { kind: 'tool-call', callId: 'call-2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'Y', new_string: 'B1' }) },
    ] } },
  ]
  const props = mkProps(nodes, 'call-1', { byId: { s1: { cwd: '/w' } }, viewMode: 'unified' })
  const tree = await env.settle(props)
  const delLines = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('ddv-row-del'))
  assert.deepEqual(delLines.map((n) => textOf(n.children[0])), ['2', '7'], 'both dels at their true disk numbers')
  assert.deepEqual(delLines.map((n) => textOf(n.children[3])), ['X', 'Y'])
  env.restoreFetch()
})

test('cross-session isolation: two sessions editing the same path never share a group', async () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  // Session 1 has a pending edit to /w/a.md; its interaction resolves rejected.
  let resolveS1
  const s1Pending = { kind: 'approval', key: 's1k', callId: 's1-call' }
  s1Pending.result = new Promise((resolve) => { resolveS1 = resolve })
  const s1Nodes = editNodes('s1-call', 'OLD ONE', 'NEW ONE')
  const s1Props = mkProps(s1Nodes, 's1-call', { byId: { s1: { cwd: '/w' } }, pendingInteraction: s1Pending, viewMode: 'unified' })
  await env.settle(s1Props)
  resolveS1('rejected')
  await env.runEffects()

  // Session 2, same file path, its own chat and pending ask. Its result is
  // UNRESOLVED: live, result only settles after someone answers, so a
  // resolved-here result would (correctly) count as an already-made decision.
  const answered = []
  const s2Pending = {
    kind: 'approval', key: 's2k', callId: 's2-call', result: new Promise(() => {}),
    answer: async (outcome) => { answered.push(outcome) },
  }
  const s2Nodes = editNodes('s2-call', 'OLD TWO', 'NEW TWO')
  const s2Props = mkProps(s2Nodes, 's2-call', { byId: { s2: { cwd: '/w' } }, pendingInteraction: s2Pending, sessionId: 's2', viewMode: 'unified' })
  const tree = await env.settle(s2Props)
  const texts = flatten(tree).map(textOf)
  assert.ok(!texts.some((t) => t.includes('NEW ONE')), "session 2's card must not absorb session 1's edit")
  assert.ok(!texts.some((t) => t.includes('2 edits merged')), 'no cross-session merged count')
  assert.ok(texts.some((t) => t.includes('NEW TWO')), 'session 2 renders its own edit')
  // Session 1's rejected outcome must not auto-answer session 2's ask.
  assert.deepEqual(answered, [], 'no decision leaked across sessions')
  env.restoreFetch()
})

test('multi-file volley: per-tab decisions; nothing settles until every file is decided', async () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  const nodes = [{
    kind: 'assistant-step',
    data: { blocks: [
      { kind: 'tool-call', callId: 'a1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A1', new_string: 'NEW A1' }) },
      { kind: 'tool-call', callId: 'a2', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'OLD A2', new_string: 'NEW A2' }) },
      { kind: 'tool-call', callId: 'b1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/b.md', old_string: 'OLD B', new_string: 'NEW B' }) },
    ] },
  }]
  const propsOf = (callId, pendingInteraction) => mkProps(nodes, callId, { byId: { s1: { cwd: '/w' } }, pendingInteraction, viewMode: 'unified' })

  // Card 1 surfaces a.md's first ask: tabs for both files, a.md active with
  // its two edits merged, b.md untouched, and the same decide bar for every
  // tab (no ordering language anywhere).
  let tree = await env.settle(propsOf('a1'))
  const tabsOf = (t) => flatten(t).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('adf-tab'))
  const tabOf = (t, name) => tabsOf(t).find((n) => textOf(n) === name)
  assert.deepEqual(tabsOf(tree).map(textOf).sort(), ['a.md!', 'b.md!'], 'one tab per pending file, undecided ones badged')
  assert.equal(flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('adf-tab-wait')).length, 2, 'waiting badges on undecided tabs')
  assert.match(textOf(tree), /2 edits merged/, 'active file merges only its own calls')
  assert.ok(textOf(tree).includes('NEW A1') && textOf(tree).includes('NEW A2'), 'a.md edits rendered')
  assert.ok(!textOf(tree).includes('NEW B'), 'b.md not rendered while inactive')
  assert.ok(textOf(tree).includes('Applies once every file is decided.'), 'the only note states the gate, not an order')

  // Decide b.md first (out of order); the tab reports it and the review
  // auto-advances to the next undecided file.
  tabOf(tree, 'b.md!').props.onClick()
  tree = env.render(propsOf('a1'))
  assert.ok(textOf(tree).includes('NEW B'), 'b.md edit rendered after switching')
  flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Allow once').props.onClick()
  tree = env.render(propsOf('a1'))
  assert.ok(textOf(tree).includes('b.md · approved'), 'tab shows the stored decision')
  assert.equal(tabOf(tree, 'a.md!').props['aria-selected'], 'true', 'deciding advances to the next undecided tab')

  // a.md still undecided: NOTHING settles, even when b.md's ask surfaces.
  const answered = []
  const bPending = {
    kind: 'approval', key: 'kb', callId: 'b1', result: new Promise(() => {}),
    answer: async (outcome) => { answered.push({ key: 'kb', outcome }) },
  }
  await env.settle(propsOf('b1', bPending))
  assert.deepEqual(answered, [], 'nothing settles until every file has a decision')

  // Decide a.md too; now the surfaced ask settles with its OWN file's
  // decision, and b.md's ask replays its stored one when it surfaces.
  const aPending = {
    kind: 'approval', key: 'ka', callId: 'a1', result: new Promise(() => {}),
    answer: async (outcome) => { answered.push({ key: 'ka', outcome }) },
  }
  tree = await env.settle(propsOf('a1', aPending))
  tabOf(tree, 'a.md!').props.onClick()
  tree = env.render(propsOf('a1', aPending))
  flatten(tree).find((n) => n.type === 'button' && textOf(n) === 'Allow once').props.onClick()
  await env.settle(propsOf('a1', aPending))
  assert.deepEqual(answered, [{ key: 'ka', outcome: 'allowed-once' }], 'surfaced ask answered once every file is decided')
  await env.settle(propsOf('b1', bPending))
  assert.deepEqual(answered, [
    { key: 'ka', outcome: 'allowed-once' },
    { key: 'kb', outcome: 'allowed-once' },
  ], 'the other file replays its stored decision when its ask surfaces')
  env.restoreFetch()
})
