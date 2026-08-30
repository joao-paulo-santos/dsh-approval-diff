/**
 * dsh-approval-diff — browser half (v0.22: the full review, native card).
 *
 * dsh 0.1.2 moved approvals into a per-session pending-interaction model:
 * the native approval card asks and decides. This plugin restores its full
 * review experience on top of that card, through the
 * `conversation.approval.detail` seat (owner props: `{ callId }`), shadowing
 * the chat view's plain detail (priority -1, lowest renders):
 *
 *   - Split / Unified views (GitHub-style toggle, choice remembered)
 *   - DISK-ANCHORED numbers: the pending edit is merged against the file's
 *     disk copy (±CONTEXT window, ellipsis for the skipped middle); without
 *     disk truth the operands render aligned with blank numbers — never
 *     lying numbers
 *   - Word-level highlights inside replaced lines (dsh-diff-view engine)
 *   - `write` renders old file as removals + new content as additions;
 *     deletion commands render a review notice
 *   - ARMING: "Auto-allow edits to this file" answers the current request
 *     and every later same-file request for the session, with a visible
 *     armed state and one-click disarm (allowed-once only, never wider)
 *   - Stale-operand warning when the edit's old text is no longer on disk
 *
 * The decision itself belongs to the native card; arming automates that
 * exact answer (`PendingApproval.answer`) but never widens it.
 */
window.__ModuleLoader__.load({ id: 'dsh-approval-diff', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')

  // ---- small helpers ------------------------------------------------------

  const splitLines = (text) => {
    const normalized = String(text).replace(/\r\n/g, '\n')
    if (normalized === '') return []
    const parts = normalized.split('\n')
    return normalized.endsWith('\n') ? parts.slice(0, -1) : parts
  }

  const baseNameOf = (path) => {
    const raw = String(path)
    const segments = raw.replace(/[/\\]+$/, '').split(/[/\\]/)
    return segments[segments.length - 1] !== '' ? segments[segments.length - 1] : raw
  }

  /** Parse a running call's argsRaw into a plain object, or null. */
  const parseToolArguments = (argsRaw) => {
    try {
      const parsed = JSON.parse(argsRaw)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (e) { return null }
  }

  /** Normalize `path` against `cwd` into a clean absolute path. */
  const absolutePathUnder = (cwd, path) => {
    const raw = String(path).replace(/\\/g, '/')
    const joined = raw.startsWith('/') || cwd === undefined || cwd === '' ? raw : cwd.replace(/\/+$/, '') + '/' + raw
    const out = []
    for (const segment of joined.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') { out.pop(); continue }
      out.push(segment)
    }
    return '/' + out.join('/')
  }

  /** Whether `lines` contains `span` as a consecutive run (first index, or -1). */
  const indexOfLineSpan = (lines, span) => {
    if (span.length === 0) return -1
    const matchLimit = lines.length - span.length
    for (let startIndex = 0; startIndex <= matchLimit; startIndex++) {
      let matched = true
      for (let spanIndex = 0; spanIndex < span.length; spanIndex++) {
        if (lines[startIndex + spanIndex] !== span[spanIndex]) { matched = false; break }
      }
      if (matched) return startIndex
    }
    return -1
  }

  // ---- disk truth (host route + module-scope cache with listeners) ---------

  /** absPath -> { status: 'loading'|'ready'|'missing', contentLines?, truncated?, freshnessKey? } */
  const hostFileContexts = new Map()
  const contextListeners = new Set()

  const requestHostFileContext = (absolutePath, freshnessKey) => {
    const existing = hostFileContexts.get(absolutePath)
    if (existing !== undefined) {
      if (existing.status === 'ready' || existing.status === 'missing') return
      if (existing.status === 'loading' && existing.freshnessKey === freshnessKey) return
    }
    hostFileContexts.set(absolutePath, { status: 'loading', freshnessKey })
    let pending
    try {
      pending = Promise.resolve(fetch('/approval-diff/context?path=' + encodeURIComponent(absolutePath)))
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then((body) => {
        hostFileContexts.set(absolutePath, body !== null && typeof body === 'object' && typeof body.content === 'string'
          ? { status: 'ready', contentLines: splitLines(body.content), truncated: body.truncated === true }
          : { status: 'missing' })
        for (const listener of [...contextListeners]) { try { listener() } catch (e) {} }
      }, () => {
        hostFileContexts.set(absolutePath, { status: 'missing' })
        for (const listener of [...contextListeners]) { try { listener() } catch (e) {} }
      })
  }

  const hostRecordOf = (absolutePath) => hostFileContexts.get(absolutePath)

  /** Bump whenever a disk-context fetch settles, so open cards re-render. */
  const useHostContextVersion = () => {
    const [version, setVersion] = React.useState(0)
    React.useEffect(() => {
      const listener = () => { setVersion((n) => n + 1) }
      contextListeners.add(listener)
      return () => { contextListeners.delete(listener) }
    }, [])
    return version
  }

  // ---- file-change derivation from a tool call ------------------------------

  const FILE_TOOL_NAMES = ['edit', 'write']

  /**
   * One pending mutation derived from the running call's arguments:
   *   { kind: 'edit'|'write'|'delete', path, oldLines, newLines }
   * or `undefined` when this detail has nothing diff-worthy to show.
   */
  const fileChangeOfCall = (toolName, args) => {
    if (args === null) return undefined
    const name = String(toolName || '').toLowerCase()
    const path = typeof args.file_path === 'string' && args.file_path !== ''
      ? args.file_path
      : (typeof args.absolute_path === 'string' && args.absolute_path !== '' ? args.absolute_path : undefined)
    if (FILE_TOOL_NAMES.includes(name)) {
      if (path === undefined) return undefined
      if (name === 'edit') {
        const oldString = typeof args.old_string === 'string' ? args.old_string : ''
        const newString = typeof args.new_string === 'string' ? args.new_string : ''
        if (oldString === '' && newString === '') return undefined
        return { kind: 'edit', path, oldLines: splitLines(oldString), newLines: splitLines(newString) }
      }
      return { kind: 'write', path, oldLines: [], newLines: splitLines(typeof args.content === 'string' ? args.content : '') }
    }
    const command = typeof args.command === 'string' ? args.command : ''
    const first = command.trim().split(/\s+/)[0] || ''
    if (['rm', 'unlink', 'rmdir', 'shred'].includes(baseNameOf(first))) {
      return { kind: 'delete', path: command.trim(), oldLines: [], newLines: [] }
    }
    return undefined
  }

  /** The running tool-call block matching `callId`, from the chat view's nodes. */
  const findCallBlock = (nodes, callId) => {
    if (callId === undefined) return undefined
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      if (node.kind !== 'assistant' && node.kind !== 'assistant-step') continue
      const data = node.data !== undefined && node.data !== null ? node.data : node
      const rawBlocks = Array.isArray(data.blocks) ? data.blocks : []
      for (const block of rawBlocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.kind === 'tool-call' && typeof block.callId === 'string' && block.callId === callId) {
          return { name: block.name, argsRaw: block.argsRaw }
        }
        if (block.type === 'tool-call' && typeof block.id === 'string' && String(block.id) === callId) {
          return { name: block.name, argsRaw: block.arguments }
        }
      }
    }
    return undefined
  }

  // ---- rendering: unified + split -------------------------------------------

  const CONTEXT = 3
  let diffEngine = undefined   // dsh-diff-view engine (resolved in apply)
  let detailViewMode = 'split' // remembered across cards for the session (v0.20 behavior)

  const wordSpanSide = (before, after, side) => {
    if (diffEngine === undefined) return side === 'del' ? before : after
    const spans = diffEngine.wordSpansOfLinePair(before, after)
    return diffEngine.wordSpanElements(side === 'del' ? spans.removedSpans : spans.addedSpans, side === 'del' ? 'adf-w-del' : 'adf-w-add')
  }

  /** Unified (one grid, -/+ runs) for the pending change. */
  const buildUnifiedRows = (change, diskLines) => {
    const cells = []
    let row = 0
    const push = (num, cls, sign, content) => {
      row += 1
      const gridRow = String(row)
      cells.push(React.createElement('div', { key: 'n' + row, className: 'adf-num', style: { gridColumn: '1', gridRow } },
        num === undefined ? '' : String(num)))
      cells.push(React.createElement('div', { key: 's' + row, className: 'adf-sign', style: { gridColumn: '2', gridRow } }, sign))
      cells.push(React.createElement('div', { key: 'c' + row, className: 'adf-cell ' + cls, style: { gridColumn: '3', gridRow } }, content))
    }
    const ellipsis = () => {
      row += 1
      cells.push(React.createElement('div', { key: 'e' + row, className: 'adf-cell adf-ctx adf-ellipsis', style: { gridColumn: '1 / -1', gridRow: String(row) } }, '\u22ef'))
    }

    if (change.kind === 'delete') {
      cells.push(React.createElement('div', { key: 'notice', className: 'adf-cell adf-del adf-delete-note', style: { gridColumn: '1 / -1', gridRow: '1' } },
        'This command deletes files. Review it before allowing.'))
      return cells
    }

    const oldLines = change.kind === 'write' ? (diskLines !== undefined ? diskLines : []) : change.oldLines
    const newLines = change.newLines

    let anchor = -1
    if (diskLines !== undefined) {
      if (change.kind === 'edit' && oldLines.length > 0) anchor = indexOfLineSpan(diskLines, oldLines)
      if (change.kind === 'write' && diskLines.length > 0) anchor = 0
    }

    if (anchor >= 0) {
      const afterStart = anchor + oldLines.length
      const headEnd = Math.min(anchor, CONTEXT)
      const tailStart = Math.max(afterStart, diskLines.length - CONTEXT)
      let diskNo = 1
      let newNo = 1
      for (let i = 0; i < headEnd; i++) { push(diskNo, 'adf-ctx', '', diskLines[i]); diskNo += 1; newNo += 1 }
      if (anchor > headEnd) {
        ellipsis()
        diskNo += anchor - headEnd
        newNo += anchor - headEnd
      }
      for (const line of oldLines) { push(diskNo, 'adf-del', '-', line); diskNo += 1 }
      for (const line of newLines) { push(newNo, 'adf-add', '+', line); newNo += 1 }
      if (tailStart > afterStart) ellipsis()
      for (let i = tailStart; i < diskLines.length; i++) { push(diskNo, 'adf-ctx', '', diskLines[i]); diskNo += 1; newNo += 1 }
      return cells
    }

    const rows = diffEngine !== undefined
      ? diffEngine.alignedEditRowsOf(oldLines, newLines)
      : oldLines.map((line, i) => ({ kind: i < newLines.length ? 'replace' : 'delete', removedLine: line, addedLine: newLines[i] }))
        .concat(newLines.slice(oldLines.length).map((line) => ({ kind: 'insert', addedLine: line })))
    for (const r of rows) {
      if (r.kind === 'same') push(undefined, 'adf-ctx', '', r.removedLine)
      else if (r.kind === 'replace') {
        push(undefined, 'adf-del', '-', wordSpanSide(r.removedLine, r.addedLine, 'del'))
        push(undefined, 'adf-add', '+', wordSpanSide(r.removedLine, r.addedLine, 'add'))
      } else if (r.kind === 'delete') push(undefined, 'adf-del', '-', r.removedLine)
      else push(undefined, 'adf-add', '+', r.addedLine)
    }
    return cells
  }

  /**
   * Split (two-sided) rows: disk-anchored context on BOTH sides, the change
   * region as removals left / additions right, paired index-wise with word
   * highlights; the shorter side pads. Without disk truth, engine-aligned
   * operand rows with blank numbers.
   */
  const buildSplitRows = (change, diskLines) => {
    const cells = []
    let row = 0
    const pushPair = (leftNum, leftCls, leftContent, rightNum, rightCls, rightContent) => {
      row += 1
      const gridRow = String(row)
      cells.push(React.createElement('div', { key: 'ln' + row, className: 'adf-num', style: { gridColumn: '1', gridRow } },
        leftNum === undefined ? '' : String(leftNum)))
      cells.push(React.createElement('div', { key: 'lc' + row, className: 'adf-cell ' + leftCls, style: { gridColumn: '2', gridRow } }, leftContent))
      cells.push(React.createElement('div', { key: 'rn' + row, className: 'adf-num', style: { gridColumn: '3', gridRow } },
        rightNum === undefined ? '' : String(rightNum)))
      cells.push(React.createElement('div', { key: 'rc' + row, className: 'adf-cell ' + rightCls, style: { gridColumn: '4', gridRow } }, rightContent))
    }
    const pushFullWidth = (cls, content) => {
      row += 1
      cells.push(React.createElement('div', { key: 'fw' + row, className: 'adf-cell ' + cls, style: { gridColumn: '1 / -1', gridRow: String(row) } }, content))
    }

    if (change.kind === 'delete') {
      pushFullWidth('adf-del adf-delete-note', 'This command deletes files. Review it before allowing.')
      return cells
    }

    const oldLines = change.kind === 'write' ? (diskLines !== undefined ? diskLines : []) : change.oldLines
    const newLines = change.newLines

    let anchor = -1
    if (diskLines !== undefined) {
      if (change.kind === 'edit' && oldLines.length > 0) anchor = indexOfLineSpan(diskLines, oldLines)
      if (change.kind === 'write' && diskLines.length > 0) anchor = 0
    }

    if (anchor >= 0) {
      const afterStart = anchor + oldLines.length
      const headEnd = Math.min(anchor, CONTEXT)
      const tailStart = Math.max(afterStart, diskLines.length - CONTEXT)
      const emitPair = (diskNo, diskLine, newNo) => {
        pushPair(diskNo, 'adf-ctx', diskLine, newNo, 'adf-ctx', diskLine)
      }
      let diskNo = 1
      let newNo = 1
      for (let i = 0; i < headEnd; i++) { emitPair(diskNo, diskLines[i], newNo); diskNo += 1; newNo += 1 }
      if (anchor > headEnd) {
        pushFullWidth('adf-ctx adf-ellipsis', '\u22ef')
        diskNo += anchor - headEnd
        newNo += anchor - headEnd
      }
      const pairCount = Math.min(oldLines.length, newLines.length)
      for (let i = 0; i < pairCount; i++) {
        pushPair(diskNo, 'adf-del', wordSpanSide(oldLines[i], newLines[i], 'del'), newNo, 'adf-add', wordSpanSide(oldLines[i], newLines[i], 'add'))
        diskNo += 1
        newNo += 1
      }
      for (let i = pairCount; i < oldLines.length; i++) { pushPair(diskNo, 'adf-del', oldLines[i], undefined, 'adf-pad', ''); diskNo += 1 }
      for (let i = pairCount; i < newLines.length; i++) { pushPair(undefined, 'adf-pad', '', newNo, 'adf-add', newLines[i]); newNo += 1 }
      if (tailStart > afterStart) pushFullWidth('adf-ctx adf-ellipsis', '\u22ef')
      for (let i = tailStart; i < diskLines.length; i++) { emitPair(diskNo, diskLines[i], newNo); diskNo += 1; newNo += 1 }
      return cells
    }

    const rows = diffEngine !== undefined
      ? diffEngine.alignedEditRowsOf(oldLines, newLines)
      : oldLines.map((line, i) => ({ kind: i < newLines.length ? 'replace' : 'delete', removedLine: line, addedLine: newLines[i] }))
        .concat(newLines.slice(oldLines.length).map((line) => ({ kind: 'insert', addedLine: line })))
    // No disk anchor: operand-relative numbers would lie about the file.
    for (const r of rows) {
      if (r.kind === 'same') pushPair(undefined, 'adf-ctx', r.removedLine, undefined, 'adf-ctx', r.addedLine)
      else if (r.kind === 'replace') {
        pushPair(undefined, 'adf-del', wordSpanSide(r.removedLine, r.addedLine, 'del'), undefined, 'adf-add', wordSpanSide(r.removedLine, r.addedLine, 'add'))
      } else if (r.kind === 'delete') pushPair(undefined, 'adf-del', r.removedLine, undefined, 'adf-pad', '')
      else pushPair(undefined, 'adf-pad', '', undefined, 'adf-add', r.addedLine)
    }
    return cells
  }

  // ---- arming (auto-allow per file, session scope) --------------------------

  /** absPath -> true. Armed files auto-answer 'allowed-once' (never wider).
   *  Persisted in localStorage: an arm survives page reloads until disarmed. */
  const ARMED_STORAGE_KEY = 'approval-diff:armed'
  const armedByPath = (() => {
    const map = new Map()
    try {
      const raw = JSON.parse(localStorage.getItem(ARMED_STORAGE_KEY) ?? '{}')
      for (const [path, outcome] of Object.entries(raw)) map.set(path, outcome)
    } catch (e) {}
    return map
  })()
  const persistArmed = () => {
    try {
      localStorage.setItem(ARMED_STORAGE_KEY, JSON.stringify(Object.fromEntries(armedByPath)))
    } catch (e) {}
  }
  const answeredInteractionKeys = new Set()

  // ---- the detail component -------------------------------------------------

  const ApprovalDetail = (props) => {
    const callId = props.callId
    const viewMode = props.viewMode
    const sessionId = props.useSession !== undefined
      ? props.useSession((snapshot) => (snapshot !== null && typeof snapshot === 'object' ? snapshot.sessionId : undefined))
      : undefined
    const cwd = props.useSessions !== undefined
      ? props.useSessions((st) => {
        const summary = sessionId !== undefined && st.byId !== undefined && st.byId !== null ? st.byId[sessionId] : undefined
        return summary !== undefined && typeof summary.cwd === 'string' ? summary.cwd : undefined
      })
      : undefined
    const nodes = props.useConversation !== undefined
      ? props.useConversation((conversation) => {
        const view = conversation !== null && typeof conversation === 'object' && conversation.views !== undefined
          ? conversation.views.get('chat')
          : undefined
        return view !== undefined && view.nodes !== undefined ? view.nodes.values() : []
      })
      : []
    const pending = props.useSessionPendingInteraction !== undefined
      ? props.useSessionPendingInteraction((map) => {
        const interaction = sessionId !== undefined && map !== undefined && typeof map.get === 'function'
          ? map.get(sessionId)
          : undefined
        return interaction !== undefined && interaction !== null && interaction.kind === 'approval'
          ? interaction
          : undefined
      })
      : undefined
    const contextVersion = useHostContextVersion()
    void contextVersion

    const call = findCallBlock(nodes, callId)
    if (call === undefined) return null
    const change = fileChangeOfCall(call.name, parseToolArguments(call.argsRaw))
    if (change === undefined) return null

    const absolutePath = change.kind === 'delete' ? undefined : absolutePathUnder(cwd, change.path)
    if (absolutePath !== undefined) requestHostFileContext(absolutePath, callId)
    const record = absolutePath !== undefined ? hostRecordOf(absolutePath) : undefined
    const diskLines = record !== undefined && record.status === 'ready' ? record.contentLines : undefined
    const staleOperand = change.kind === 'edit' && diskLines !== undefined
      && indexOfLineSpan(diskLines, change.oldLines) === -1

    const armed = absolutePath !== undefined && armedByPath.has(absolutePath)

    // Arming auto-answer: an armed file answers its own pending request once
    // (side effect in an effect, not during render).
    const autoAnswerKey = armed && pending !== undefined && pending.callId === callId
      && absolutePath !== undefined && !answeredInteractionKeys.has(pending.key)
      && pending.answer !== undefined
      ? pending.key
      : undefined
    React.useEffect(() => {
      if (autoAnswerKey === undefined || pending === undefined) return
      answeredInteractionKeys.add(pending.key)
      console.info('[approval-diff] auto-allowed (armed): ' + pending.key)
      pending.answer('allowed-once').catch(() => { answeredInteractionKeys.delete(pending.key) })
    }, [autoAnswerKey, pending])

    return React.createElement('div', { className: 'adf-detail' },
      React.createElement('div', { className: 'adf-detail-head' },
        React.createElement('span', { className: 'adf-detail-kind' }, change.kind),
        React.createElement('span', { className: 'adf-detail-path', title: change.path }, change.path),
        record !== undefined && record.truncated === true
          ? React.createElement('span', { className: 'adf-detail-note' }, 'disk preview truncated') : null,
        React.createElement('div', { className: 'adf-viewtoggle', role: 'group', 'aria-label': 'Diff view mode' },
          React.createElement('button', {
            type: 'button',
            className: 'adf-viewbtn' + (viewMode !== 'unified' ? ' adf-viewbtn-active' : ''),
            title: 'Split view: old and new side by side',
            onClick: () => { props.setViewMode('split') },
          }, 'Split'),
          React.createElement('button', {
            type: 'button',
            className: 'adf-viewbtn' + (viewMode === 'unified' ? ' adf-viewbtn-active' : ''),
            title: 'Unified view: one column with - and + lines',
            onClick: () => { props.setViewMode('unified') },
          }, 'Unified'))),
      staleOperand ? React.createElement('div', { className: 'adf-detail-warn' },
        'The edit\u2019s old text was not found in the current file. The model may be working from a stale read, so review carefully.') : null,
      armed ? React.createElement('div', { className: 'adf-detail-armed', title: absolutePath },
        React.createElement('span', null, 'armed: edits to ' + baseNameOf(absolutePath) + ' auto-allow until you disarm'),
        React.createElement('button', {
          type: 'button', className: 'adf-detail-disarm', title: 'Stop auto-allowing this file',
          onClick: () => { armedByPath.delete(absolutePath); persistArmed(); props.bumpArmed() },
        }, 'disarm')) : null,
      props.viewMode === 'unified'
        ? React.createElement('div', { className: 'adf-grid adf-grid-unified adf-detail-grid' }, buildUnifiedRows(change, diskLines))
        : React.createElement('div', { className: 'adf-grid adf-grid-twoside adf-detail-grid' }, buildSplitRows(change, diskLines)),
      change.kind !== 'delete' && absolutePath !== undefined && !armed
        ? React.createElement('div', { className: 'adf-detail-arm' },
          React.createElement('button', {
            type: 'button', className: 'adf-arm-btn', title: 'Answer this request and auto-allow later edits to this file',
            onClick: () => {
              armedByPath.set(absolutePath, 'allowed-once')
              persistArmed()
              props.bumpArmed()
            },
          }, 'Auto-allow edits to this file')) : null)
  }

  module.exports = {
    name: 'approval-diff-client',
    // Hard dependencies (guide Case 22): the slot service for the detail seat,
    // dsh-diff-view for the shared diff engine + stylesheet.
    inject: ['slots', 'diffView'],
    apply(ctx) {
      diffEngine = ctx.diffView.engine
      // Registered component: a thin stateful wrapper holding the remembered
      // view mode + an armed-version counter, so toggling/re-arming re-renders.
      const offDetail = ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register(
        { name: 'conversation.approval.detail', priority: -1 },
        (ownerProps) => {
          const [modeVersion, bumpMode] = React.useState(0)
          const [armedVersion, bumpArmed] = React.useState(0)
          void modeVersion
          void armedVersion
          return ApprovalDetail({
            ...ownerProps,
            viewMode: detailViewMode,
            setViewMode: (mode) => { detailViewMode = mode; bumpMode((n) => n + 1) },
            bumpArmed: () => { bumpArmed((n) => n + 1) },
          })
        }))

      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-approval-diff'
      tag.textContent = '.adf-detail{border:1px solid var(--dsw-alias-label-tertiary);border-radius:10px;overflow:hidden;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-primary)}'
        + '.adf-detail-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-label-tertiary)}'
        + '.adf-detail-kind{font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);text-transform:uppercase;letter-spacing:.03em}'
        + '.adf-detail-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}'
        + '.adf-detail-note{font-style:italic;opacity:.6}'
        + '.adf-detail-warn{padding:8px 12px;background:rgba(210,153,34,.10);color:#d29922;border-bottom:1px solid rgba(210,153,34,.25);font-size:12px}'
        + '.adf-detail-armed{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px;background:rgba(63,185,80,.10);color:#3fb950;border-bottom:1px solid rgba(63,185,80,.25);font-size:11.5px}'
        + '.adf-detail-disarm{font:inherit;font-size:11px;cursor:pointer;color:inherit;background:transparent;border:1px solid rgba(63,185,80,.45);border-radius:6px;padding:2px 8px}'
        + '.adf-detail-arm{display:flex;justify-content:flex-end;padding:8px 12px;border-top:1px solid var(--dsw-alias-label-tertiary)}'
        + '.adf-arm-btn{font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-label-tertiary);border-radius:999px;padding:4px 10px}'
        + '.adf-arm-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}'
        + '.adf-detail-grid{padding:6px 0;max-height:340px;overflow:auto;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5}'
        + '.adf-delete-note{font-family:inherit;padding:10px 12px;font-size:12px}'
        + '.adf-pad{background:transparent}'
      document.head.appendChild(tag)

      return () => {
        try { offDetail() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }
  return module.exports
} })
