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

/** Load both bundles; apply the plugin; return the detail component + seen elements. */
const loadDetail = () => {
  const seen = []
  const react = {
    createElement: (type, props, ...children) => {
      const el = { type, props, children: children.flat(Infinity) }
      seen.push(el)
      return el
    },
    Fragment: 'FRAGMENT',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
  }
  const provided = {}
  const registrations = []
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
  const dispose = plugin.apply({
    inject: plugin.inject,
    slots: {
      inject: (seat, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component }); return component },
    },
    diffView: provided.diffView,
    get: (n) => (n === 'diffView' ? provided.diffView : undefined),
    provide: () => {},
    on: () => () => {},
  })
  return {
    Detail: registered[0].component,
    registered,
    seen,
    dispose,
    setFetch: (fn) => { globalThis.fetch = fn },
    restoreFetch: () => { globalThis.fetch = savedFetch },
  }
}

const mkProps = (chatNodes, { byId = {} } = {}) => ({
  callId: chatNodes.callId,
  useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? { nodes: { values: () => chatNodes } } : undefined) } }),
  useSessions: (sel) => sel({ byId }),
  useSession: (sel) => sel({ sessionId: 's1' }),
})
const withCallId = (nodes, callId) => { nodes.callId = callId; return nodes }

test('registers the conversation.approval.detail seat; dispose unregisters', () => {
  const env = loadDetail()
  assert.equal(env.registered.length, 1)
  assert.equal(env.registered[0].options.name, 'conversation.approval.detail')
  assert.equal(env.registered[0].options.priority, -1, 'shadows the chat view default detail (lowest renders)')
  assert.equal(typeof env.registered[0].component, 'function')
  env.dispose()
  // a second apply re-registers cleanly (module table invalidated upstream)
  const second = loadDetail()
  assert.equal(second.registered.length, 1)
  second.restoreFetch()
})

test('detail: edit call renders dels and adds with word highlights (fallback, no disk)', () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('network not needed in the fallback') })
  const nodes = withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: JSON.stringify({ file_path: '/w/a.md', old_string: 'const a = 1;', new_string: 'const b = 2;' }) }] } }], 'call-1')
  const tree = env.Detail(mkProps(nodes))
  const flat = flatten(tree)
  assert.ok(flat.some((n) => textOf(n) === 'const a = 1;'), 'old operand rendered as a removal')
  assert.ok(flat.some((n) => textOf(n) === 'const b = 2;'), 'new operand rendered as an addition')
  assert.ok(firstByClass(tree, 'adf-del') !== undefined, 'del row present')
  assert.ok(firstByClass(tree, 'adf-add') !== undefined, 'add row present')
  const numCells = flat.filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('adf-num'))
  assert.ok(numCells.every((n) => textOf(n) === ''), 'fallback rows carry blank numbers — never lying numbers')
  env.restoreFetch()
})

test('detail: disk truth anchors the numbers and collapses the middle', async () => {
  const env = loadDetail()
  const disk = ['l1', 'l2', 'l3', 'l4', 'l5', 'OLD A', 'OLD B', 'l8', 'l9', 'l10']
  env.setFetch(() => ({ ok: true, json: async () => ({ path: '/w/a.md', content: disk.join('\n'), truncated: false }) }))
  const chatNodes = withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-9', name: 'edit', argsRaw: JSON.stringify({ file_path: 'a.md', old_string: 'OLD A\nOLD B', new_string: 'NEW A\nNEW B' }) }] } }], 'call-9')
  const props = {
    callId: 'call-9',
    useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? { nodes: { values: () => chatNodes } } : undefined) } }),
    useSessions: (sel) => sel({ byId: { s1: { cwd: '/w' } } }),
    useSession: (sel) => sel({ sessionId: 's1' }),
  }
  env.Detail(props)                                   // kick the fetch (cache: loading)
  await new Promise((r) => setTimeout(r, 5))
  const tree = env.Detail(props)                      // cache: ready -> anchored render
  const flat = flatten(tree)
  const numTexts = flat
    .filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('adf-num'))
    .map(textOf)
  // head context l1-l3 (disk 1-3), ellipsis skips l4-l5, OLD A=6/OLD B=7 removed,
  // NEW A=6/NEW B=7 added, ellipsis skipped in tailStart math, tail l8-l10 as 8-10
  assert.deepEqual(numTexts, ['1', '2', '3', '6', '7', '6', '7', '8', '9', '10'])
  assert.ok(flat.some((n) => textOf(n) === 'NEW A'), 'new side rendered')
  assert.ok(flat.some((n) => typeof n.props?.className === 'string' && n.props.className.includes('adf-ellipsis')), 'middle collapsed')
  env.restoreFetch()
})

test('detail: non-file tools and unparseable args render nothing', () => {
  const env = loadDetail()
  const readProps = mkProps(withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-1', name: 'read', argsRaw: '{}' }] } }], 'call-1'))
  assert.equal(env.Detail(readProps), null, 'read tool renders nothing')
  const badProps = mkProps(withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-1', name: 'edit', argsRaw: '{not json' }] } }], 'call-1'))
  assert.equal(env.Detail(badProps), null, 'unparseable args render nothing')
})

test('detail: write call without disk shows the new content as additions', () => {
  const env = loadDetail()
  env.setFetch(() => { throw new Error('no disk in this test') })
  const nodes = withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-2', name: 'write', argsRaw: JSON.stringify({ file_path: '/w/new.md', content: 'hello\nworld' }) }] } }], 'call-2')
  const tree = env.Detail(mkProps(nodes))
  const flat = flatten(tree)
  assert.ok(flat.some((n) => textOf(n) === 'hello'), 'write content rendered')
  assert.ok(firstByClass(tree, 'adf-add') !== undefined, 'add rows present')
  env.restoreFetch()
})

test('detail: delete command shows the review notice', () => {
  const env = loadDetail()
  const nodes = withCallId([{ kind: 'assistant-step', data: { blocks: [{ kind: 'tool-call', callId: 'call-3', name: 'bash', argsRaw: JSON.stringify({ command: 'rm -rf build/' }) }] } }], 'call-3')
  const tree = env.Detail(mkProps(nodes))
  assert.match(textOf(tree), /deletes files/, 'deletion notice rendered')
})
