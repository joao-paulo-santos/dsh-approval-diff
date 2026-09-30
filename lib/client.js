/**
 * dsh-approval-diff — browser half (v0.24: one merged review per file).
 *
 * dsh 0.1.2 moved approvals into a per-session pending-interaction model:
 * the native approval card asks and decides, one request at a time. This
 * plugin keeps its reason to exist on top of that card, through the
 * `conversation.approval.detail` seat (owner props: `{ callId }`, priority
 * -1 shadowing the chat view's plain detail):
 *
 *   - MERGED REVIEW: every PENDING (unsettled) edit to the same file that
 *     the model has already emitted — the current call plus any later
 *     same-file calls visible in the chat — renders as ONE merged diff,
 *     merged sequentially against the file's disk copy. The user reviews
 *     everything that will be accepted before answering.
 *   - The native card's answer applies to the whole merged review: when each
 *     later same-file ask surfaces, it is auto-answered with the outcome
 *     the user already saw (allowed-once / rejected — never wider).
 *   - Split / Unified views (GitHub-style toggle, choice remembered).
 *   - Word-level highlights (dsh-diff-view engine); blank numbers instead
 *     of lying numbers when there is no anchor; stale-operand warning.
 */
window.__ModuleLoader__.load({ id: 'dsh-approval-diff', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')

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

  const parseToolArguments = (argsRaw) => {
    try {
      const parsed = JSON.parse(argsRaw)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (e) { return null }
  }

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

  const hostFileContexts = new Map()
  const contextListeners = new Set()

  const requestHostFileContext = (absolutePath, freshnessKey) => {
    const existing = hostFileContexts.get(absolutePath)
    if (existing !== undefined) {
      if (existing.status === 'ready' || existing.status === 'missing') return
      if (existing.status === 'loading' && existing.freshnessKey === freshnessKey) return
    }
    hostFileContexts.set(absolutePath, { status: 'loading', freshnessKey })
    let pendingRequest
    try {
      pendingRequest = Promise.resolve(fetch('/approval-diff/context?path=' + encodeURIComponent(absolutePath)))
    } catch (error) {
      pendingRequest = Promise.reject(error)
    }
    pendingRequest
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

  const FILE_TOOL_NAMES = ['edit', 'write']

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

  // ---- rendering: merged hunks, unified or split ----------------------------

  const CONTEXT = 3
  let diffViewService = undefined
  let DiffFile = undefined
  let detailViewMode = 'split'

  /**
   * Merged diff HUNKS for EVERY pending edit of one file: each edit's
   * operand span is located in the running disk copy (earlier group edits
   * already applied) and rendered at its own disk numbers, with ±CONTEXT
   * neighborhood; distant stretches split into separate hunks (the hunk
   * headers carry the collapse, FileDiff-style). Without disk truth, or for
   * spans that no longer match, the operands render as UNNUMBERED hunks —
   * never lying numbers.
   */
  const buildHunks = (changes, diskLines) => {
    const anchoredChanges = changes.filter((c) => c.kind === 'edit' || c.kind === 'write')
    const regions = []
    const unanchored = []
    if (diskLines !== undefined) {
      let running = diskLines.slice()
      let appliedDelta = 0
      for (const change of anchoredChanges) {
        const at = change.oldLines.length > 0
          ? indexOfLineSpan(running, change.oldLines)
          : (change.kind === 'write' ? 0 : -1)
        if (at < 0) { unanchored.push(change); continue }
        // `at` indexes the RUNNING copy (prior edits applied); convert back
        // to disk coordinates by removing prior net growth.
        regions.push({ start: at - appliedDelta, oldLines: change.oldLines, newLines: change.newLines })
        running = running.slice(0, at).concat(change.newLines, running.slice(at + change.oldLines.length))
        appliedDelta += change.newLines.length - change.oldLines.length
      }
    } else {
      for (const change of anchoredChanges) unanchored.push(change)
    }

    const hunks = []
    if (diskLines !== undefined && regions.length > 0) {
      // Keep every disk line within CONTEXT of a change; the tail's last
      // CONTEXT lines always render.
      const kept = new Array(diskLines.length).fill(false)
      for (const region of regions) {
        for (let i = Math.max(0, region.start - CONTEXT); i < Math.min(diskLines.length, region.start + region.oldLines.length + CONTEXT); i += 1) kept[i] = true
      }
      const ops = []
      let lastOld = 0
      let lastNew = 0
      let gap = false
      const pushCtx = (text) => { lastOld += 1; lastNew += 1; ops.push({ kind: 'ctx', old: lastOld, new: lastNew, text }) }
      let cursor = 0
      for (const region of regions) {
        while (cursor < region.start) {
          if (kept[cursor]) pushCtx(diskLines[cursor])
          else { gap = true; lastOld += 1; lastNew += 1 }
          cursor += 1
        }
        for (const line of region.oldLines) { lastOld += 1; ops.push({ kind: 'del', old: lastOld, text: line }) }
        for (const line of region.newLines) { lastNew += 1; ops.push({ kind: 'add', new: lastNew, text: line }) }
        cursor = region.start + region.oldLines.length
      }
      const last = regions[regions.length - 1]
      const lastEnd = last.start + last.oldLines.length
      const tailStart = Math.max(lastEnd, diskLines.length - CONTEXT)
      if (tailStart > cursor) {
        gap = true
        lastOld += tailStart - cursor
        lastNew += tailStart - cursor
        cursor = tailStart
      }
      while (cursor < diskLines.length) { pushCtx(diskLines[cursor]); cursor += 1 }

      let open = null
      let seenOld = 0
      let seenNew = 0
      const close = () => { if (open !== null) { hunks.push(open); open = null } }
      for (const op of ops) {
        if (gap) { close(); gap = false }
        if (open === null) {
          open = {
            oldStart: op.old !== undefined ? op.old : seenOld,
            oldLines: 0,
            newStart: op.new !== undefined ? op.new : seenNew,
            newLines: 0,
            lines: [],
          }
        }
        open.lines.push((op.kind === 'del' ? '-' : op.kind === 'add' ? '+' : ' ') + op.text)
        if (op.old !== undefined) { open.oldLines += 1; seenOld = op.old }
        if (op.new !== undefined) { open.newLines += 1; seenNew = op.new }
      }
      close()
    }

    for (const change of unanchored) {
      const operandHunks = diffViewService !== undefined
        ? diffViewService.hunksOf(change.oldLines.join('\n'), change.newLines.join('\n'))
        : [{ oldStart: 0, oldLines: change.oldLines.length, newStart: 0, newLines: change.newLines.length,
             lines: [...change.oldLines.map((l) => '-' + l), ...change.newLines.map((l) => '+' + l)] }]
      for (const hunk of operandHunks) hunks.push({ ...hunk, unnumbered: true })
    }
    return hunks
  }

  // ---- merged-group + arming state ------------------------------------------

  /** 'sessionId\nabsPath' -> { outcome?, calls: [{ callId, oldLines, newLines }] }.
   *  A group merges EVERY pending same-file edit the user will be asked
   *  about into one review; the native card's answer applies to all of them.
   *  Keyed per session so concurrent sessions never share review state. */
  const groupsByPath = new Map()
  const answeredInteractionKeys = new Set()
  /** sessionId -> absPath: the multi-file tab the user is looking at. */
  const activeTabBySession = new Map()

  // Floating decide bars: mark ".adf-more-below" while the card's scroll
  // body still has content below the fold. The scroller is native, so track
  // it from outside via a capture-phase listener plus a per-render
  // recompute (scroll events alone miss the initial state).
  const updateDecideBars = () => {
    if (typeof document.querySelectorAll !== 'function') return
    for (const bar of document.querySelectorAll('.adf-decidebar')) {
      const scroller = typeof bar.closest === 'function' ? bar.closest('[data-approval-scroll]') : null
      if (scroller === null || scroller === undefined) continue
      const more = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4
      bar.classList.toggle('adf-more-below', more)
    }
  }
  const scheduleDecideBarUpdate = () => {
    try { setTimeout(updateDecideBars, 0) } catch (e) {}
  }

  const useBump = () => {
    const [, setVersion] = React.useState(0)
    return () => { setVersion((n) => n + 1) }
  }
  const useDiskVersion = () => {
    const [version, setVersion] = React.useState(0)
    React.useEffect(() => {
      const listener = () => { setVersion((n) => n + 1) }
      contextListeners.add(listener)
      return () => { contextListeners.delete(listener) }
    }, [])
    return version
  }

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
    const chatView = props.useConversation !== undefined
      ? props.useConversation((conversation) => {
        const view = conversation !== null && typeof conversation === 'object' && conversation.views !== undefined
          ? conversation.views.get('chat')
          : undefined
        return view !== undefined && view.nodes !== undefined ? { nodes: view.nodes.values() } : { nodes: [] }
      })
      : { nodes: [] }
    const nodes = chatView.nodes
    // The REAL pending-interaction path (v0.24.2 live fix): useSessionStatus is
    // a GLOBAL STANDARD prop every slot entry receives; its snapshot carries
    // SessionStatus.pendingInteraction — the live PendingApproval instance
    // (with .result/.answer/.key). The previous useSessionPendingInteraction
    // hook existed nowhere in the harness (invented name), so it was always
    // undefined live and the merged-review auto-answer never fired: every
    // same-file ask needed its own user decision.
    const sessionStatus = props.useSessionStatus !== undefined
      ? props.useSessionStatus((statusMap) => (sessionId !== undefined && statusMap !== undefined
        && typeof statusMap.get === 'function' ? statusMap.get(sessionId) : undefined))
      : undefined
    const pendingInteraction = sessionStatus !== undefined && sessionStatus !== null
      && typeof sessionStatus === 'object' && sessionStatus.pendingInteraction !== undefined
      && sessionStatus.pendingInteraction !== null && sessionStatus.pendingInteraction.kind === 'approval'
      ? sessionStatus.pendingInteraction
      : undefined
    const diskVersion = useDiskVersion()
    void diskVersion
    const bumpArmed = useBump()

    const call = findCallBlock(nodes, callId)
    if (call === undefined) return null
    const change = fileChangeOfCall(call.name, parseToolArguments(call.argsRaw))
    if (change === undefined) return null

    const absolutePath = change.kind === 'delete' ? undefined : absolutePathUnder(cwd, change.path)

    // Settled calls: tool results already in the conversation.
    const settledCallIds = new Set()
    for (const node of nodes) {
      const root = node !== null && typeof node === 'object' && node.data !== null && typeof node.data === 'object'
        ? node.data.root
        : undefined
      if (root !== null && typeof root === 'object' && root.kind === 'tool-result' && typeof root.callId === 'string') {
        settledCallIds.add(root.callId)
      }
    }

    // THE VOLLEY INDEX: every path with unsettled edit calls in this chat
    // (the pending files of the current message). Each path is one tab and
    // one per-file merged review with its own decision.
    const volleyByPath = new Map()
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      if (node.kind !== 'assistant' && node.kind !== 'assistant-step') continue
      const data = node.data !== undefined && node.data !== null ? node.data : node
      const rawBlocks = Array.isArray(data.blocks) ? data.blocks : []
      for (const block of rawBlocks) {
        if (block === null || typeof block !== 'object') continue
        const blockCallId = block.kind === 'tool-call' && typeof block.callId === 'string' ? block.callId
          : (block.type === 'tool-call' && typeof block.id === 'string' ? String(block.id) : undefined)
        if (blockCallId === undefined || settledCallIds.has(blockCallId)) continue
        const blockChange = fileChangeOfCall(block.name, parseToolArguments(block.argsRaw ?? block.arguments))
        if (blockChange === undefined || blockChange.kind === 'delete') continue
        const blockPath = absolutePathUnder(cwd, blockChange.path)
        if (blockPath === undefined) continue
        let entries = volleyByPath.get(blockPath)
        if (entries === undefined) { entries = []; volleyByPath.set(blockPath, entries) }
        if (entries.some((c) => c.callId === blockCallId)) continue
        entries.push({ callId: blockCallId, oldLines: blockChange.oldLines, newLines: blockChange.newLines })
      }
    }

    // Maintain every volley path's group: cleanup once all its calls settled,
    // absorb the pending calls. Groups stay keyed per session AND path, so
    // concurrent sessions never share a review or a saved decision.
    const sessionKey = String(sessionId ?? '')
    const groupsOfVolley = new Map()
    for (const path of volleyByPath.keys()) {
      const key = sessionKey + '\n' + path
      let group = groupsByPath.get(key)
      if (group !== undefined && group.calls.every((c) => settledCallIds.has(c.callId))) {
        groupsByPath.delete(key)
        group = undefined
      }
      if (group === undefined) { group = { outcome: undefined, calls: [] }; groupsByPath.set(key, group) }
      for (const entry of volleyByPath.get(path)) {
        if (!group.calls.some((c) => c.callId === entry.callId)) group.calls.push(entry)
      }
      groupsOfVolley.set(path, group)
    }

    // The active tab: the user's remembered pick, else the surfaced file.
    const savedTab = activeTabBySession.get(sessionKey)
    const volleyPaths = [...volleyByPath.keys()]
    const activePath = change.kind !== 'delete'
      ? (savedTab !== undefined && volleyPaths.includes(savedTab) ? savedTab
        : absolutePath !== undefined && volleyPaths.includes(absolutePath) ? absolutePath
        : volleyPaths[0])
      : undefined
    const activeGroup = activePath !== undefined ? groupsOfVolley.get(activePath) : undefined
    const mergedEdits = activeGroup !== undefined
      ? activeGroup.calls.map((c) => ({ kind: 'edit', path: activePath, oldLines: c.oldLines, newLines: c.newLines }))
      : [change]
    const mergedCount = mergedEdits.length

    // Disk truth serves the ACTIVE tab (the surfaced file's context loads
    // when its own card renders).
    if (activePath !== undefined) requestHostFileContext(activePath, callId)
    const record = activePath !== undefined ? hostRecordOf(activePath) : undefined
    const diskLines = record !== undefined && record.status === 'ready' ? record.contentLines : undefined
    const staleOperand = activeGroup !== undefined && diskLines !== undefined
      && activeGroup.calls.some((c) => c.oldLines.length > 0 && indexOfLineSpan(diskLines, c.oldLines) === -1)

    // Per-file decisions. Buttons only STORE an outcome; nothing settles
    // until EVERY pending file has one, then the surfaced ask is answered
    // with its own file's decision and the rest replay as they surface.
    // Deciding a tab advances the review to the next file needing a pick.
    const decide = (path, outcome) => {
      const targetGroup = groupsOfVolley.get(path)
      if (targetGroup === undefined || targetGroup.outcome !== undefined) return
      targetGroup.outcome = outcome
      const next = volleyPaths.find((p) => p !== path && decidedStateOf(p) === undefined)
      if (next !== undefined) activeTabBySession.set(sessionKey, next)
      bumpArmed()
    }
    const decidedStateOf = (path) => {
      const g = groupsOfVolley.get(path)
      if (g === undefined || g.outcome === undefined) return undefined
      return g.outcome === 'rejected' ? 'rejected' : 'approved'
    }
    // The gate: every volley file has an explicit pick. One pick alone
    // never resolves another file's outcome.
    const allPicked = change.kind !== 'delete' && volleyPaths.length > 0
      && volleyPaths.every((path) => decidedStateOf(path) !== undefined)

    // Decision propagation: the native card's answer applies to the WHOLE
    // merged review the user approved — later same-file asks auto-answer
    // with the outcome they already saw. The write is deliberately NOT
    // lifecycle-gated: by the time the result promise resolves, this detail
    // has usually moved on to the NEXT ask (or unmounted), and a live-flag
    // cleanup here discarded the outcome — the "asked 3 times" bug. The
    // group map is module-scoped; a late write is safe and required.
    React.useEffect(() => {
      const result = pendingInteraction !== undefined && pendingInteraction.result !== undefined
        ? pendingInteraction.result
        : undefined
      if (result === undefined || absolutePath === undefined) return
      const key = String(sessionId ?? '') + '\n' + absolutePath
      result.then((outcome) => {
        const g = groupsByPath.get(key)
        if (g !== undefined && g.outcome === undefined) g.outcome = outcome
      }, () => {})
    }, [pendingInteraction, absolutePath, sessionId])

    // The surfaced ask settles only when the whole volley is picked; its
    // answer is its OWN file's pick.
    const currentDecision = () => {
      if (absolutePath === undefined) return undefined
      const g = groupsOfVolley.get(absolutePath)
      return g !== undefined ? g.outcome : undefined
    }
    const autoOutcome = allPicked ? currentDecision() : undefined
    const autoAnswerKey = autoOutcome !== undefined && pendingInteraction !== undefined
      && !answeredInteractionKeys.has(pendingInteraction.key)
      && pendingInteraction.answer !== undefined
      ? pendingInteraction.key
      : undefined
    React.useEffect(() => {
      if (autoAnswerKey === undefined || pendingInteraction === undefined || autoOutcome === undefined) return
      answeredInteractionKeys.add(pendingInteraction.key)
      console.info('[approval-diff] auto-answered (merged review):', pendingInteraction.key, autoOutcome)
      pendingInteraction.answer(autoOutcome).catch(() => { answeredInteractionKeys.delete(pendingInteraction.key) })
    }, [autoAnswerKey, pendingInteraction, autoOutcome])

    // Keep the floating decide bar's more-below state fresh after content
    // changes (tab switch, disk arrival, view mode flip).
    React.useEffect(() => {
      scheduleDecideBarUpdate()
    }, [activePath, diskLines, mergedCount, viewMode])

    const headerPath = activePath !== undefined ? activePath : change.path

    const diffBody = change.kind === 'delete'
      ? React.createElement('div', { className: 'adf-delete-note' },
          'This command deletes files. Review it before allowing.')
      : DiffFile({
          hunks: buildHunks(mergedEdits, diskLines),
          mode: viewMode === 'unified' ? 'unified' : 'split',
          path: headerPath,
        })

    // Tabs appear when the volley touches more than one file. Undecided
    // tabs carry an amber background: action needed.
    const showTabs = change.kind !== 'delete' && volleyPaths.length > 1
    const tabsBar = showTabs ? React.createElement('div', { className: 'adf-tabs', role: 'tablist', 'aria-label': 'Files in this request' },
      volleyPaths.map((path) => {
        const decided = decidedStateOf(path)
        return React.createElement('button', {
          key: path, type: 'button', role: 'tab', title: decided === undefined ? path + ' (waiting for a decision)' : path,
          'aria-selected': path === activePath ? 'true' : 'false',
          className: 'adf-tab' + (path === activePath ? ' adf-tab-active' : '')
            + (decided === undefined ? ' adf-tab-wait' : ' adf-tab-' + decided),
          onClick: () => { activeTabBySession.set(sessionKey, path); bumpArmed() },
        }, decided === undefined ? baseNameOf(path) : baseNameOf(path) + ' · ' + decided)
      })) : null

    // Every file's decision lives on its own tab. The bar is identical
    // whether the file is the surfaced one or not: store a decision, change
    // it until the volley completes. The native card's own buttons are
    // hidden (see the stylesheet rule) whenever this bar is mounted.
    const activeDecided = activeGroup !== undefined ? activeGroup.outcome : undefined
    const decidedLabel = activeDecided === 'rejected' ? 'Rejected' : 'Approved'
    const needsPick = (path) => decidedStateOf(path) === undefined
    const appliesNote = volleyPaths.length > 1 && volleyPaths.some(needsPick) ? ' · applies once every file is decided' : ''
    const decideBar = change.kind !== 'delete' && activePath !== undefined
      ? (activeDecided !== undefined
        ? React.createElement('div', { className: 'adf-decidebar' },
            React.createElement('span', { className: 'adf-decide-note' + (activeDecided === 'rejected' ? ' adf-decide-rejected' : '') },
              decidedLabel + appliesNote),
            React.createElement('button', {
              type: 'button', className: 'adf-change-btn', title: 'Change this decision',
              onClick: () => { activeGroup.outcome = undefined; bumpArmed() },
            }, 'change'))
        : React.createElement('div', { className: 'adf-decidebar' },
            React.createElement('span', { className: 'adf-decide-note' },
              volleyPaths.length > 1 ? 'Applies once every file is decided.' : ''),
            React.createElement('div', { className: 'adf-decide-btns' },
              React.createElement('button', {
                type: 'button', className: 'adf-btn-decide adf-btn-reject', title: 'Reject this file\u2019s changes',
                onClick: () => decide(activePath, 'rejected'),
              }, 'Reject'),
              React.createElement('button', {
                type: 'button', className: 'adf-btn-decide adf-btn-allow', title: 'Allow this file\u2019s changes',
                onClick: () => decide(activePath, 'allowed-once'),
              }, 'Allow once'))))
      : null

    // The tab bar sits OUTSIDE the bordered diff card: it reads as a switcher
    // for the whole review, not a control inside one file's diff.
    return React.createElement('div', { className: 'adf-detailwrap' },
      tabsBar,
      React.createElement('div', { className: 'adf-detail' },
        React.createElement('div', { className: 'adf-detail-head' },
          React.createElement('span', { className: 'adf-detail-kind' }, change.kind),
          React.createElement('span', { className: 'adf-detail-path', title: headerPath }, headerPath),
          mergedCount > 1 ? React.createElement('span', { className: 'adf-detail-queued' }, mergedCount + ' edits merged') : null,
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
        React.createElement('div', { className: 'adf-detail-grid' }, diffBody),
        decideBar))
  }

  module.exports = {
    name: 'approval-diff-client',
    inject: ['slots', 'diffView'],
    apply(ctx) {
      diffViewService = ctx.diffView
      DiffFile = ctx.diffView.diffFileComponent({ showToggle: false, wrap: true, scroll: false })
      const offDetail = ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register(
        { name: 'conversation.approval.detail', priority: -1 },
        (ownerProps) => {
          const [modeVersion, bumpMode] = React.useState(0)
          void modeVersion
          return ApprovalDetail({
            ...ownerProps,
            viewMode: ownerProps.viewMode !== undefined ? ownerProps.viewMode : detailViewMode,
            setViewMode: (mode) => { detailViewMode = mode; bumpMode((n) => n + 1) },
          })
        }))

      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-approval-diff'
      tag.textContent = '.adf-detailwrap{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-primary)}'
        + '.adf-detail{border:1px solid var(--dsw-alias-label-tertiary);border-radius:10px;font-size:12px}'
        + '.adf-detail>*:last-child{border-radius:0 0 10px 10px}'
        + '.adf-detail-head{border-radius:10px 10px 0 0}'
        + '.adf-detail-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-label-tertiary)}'
        + '.adf-viewtoggle{display:inline-flex;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;overflow:hidden}'
        + '.adf-viewbtn{font:inherit;font-size:11px;line-height:1;padding:4px 9px;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:transparent;border:none}'
        + '.adf-viewbtn:hover{color:var(--dsw-alias-label-primary)}'
        + '.adf-viewbtn-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}'
        + '.adf-detail-kind{font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);text-transform:uppercase;letter-spacing:.03em}'
        + '.adf-detail-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}'
        + '.adf-detail-note{font-style:italic;opacity:.6}'
        + '.adf-detail-queued{font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:#3b82f6;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.35)}'
        + '.adf-detail-warn{padding:8px 12px;background:rgba(210,153,34,.10);color:#d29922;border-bottom:1px solid rgba(210,153,34,.25);font-size:12px}'
        + '.adf-detail-grid{border-top:1px solid var(--dsw-alias-border-l3)}'
        + '.adf-tabs{display:flex;gap:2px;padding:0 4px;margin-bottom:6px;overflow-x:auto;scrollbar-width:none;border-bottom:0.5px solid var(--dsw-alias-border-l3)}'
        + '.adf-tabs::-webkit-scrollbar{display:none}'
        + '.adf-tab{font:inherit;font-size:11.5px;line-height:1;padding:6px 10px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-tertiary);background:transparent;border:none;border-bottom:2px solid transparent;margin-bottom:-0.5px}'
        + '.adf-tab:hover{color:var(--dsw-alias-label-primary)}'
        + '.adf-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}'
        + '.adf-tab-wait{background:rgba(210,153,34,.16);border-radius:6px 6px 0 0}'
        + '.adf-tab-approved{color:var(--dsw-alias-state-success-primary)}'
        + '.adf-tab-rejected{color:var(--dsw-alias-state-error-primary)}'
        + '.adf-decidebar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l3);position:sticky;bottom:0;z-index:2;background:var(--dsw-specific-input-major)}'
        // While the diff still has content below the fold, the floating bar
        // carries a fade and a shadow so scrolling stays discoverable; both
        // vanish at the bottom, where the bar settles into place.
        + '.adf-decidebar.adf-more-below{box-shadow:0 12px 14px -10px rgba(0,0,0,.45)}'
        + '.adf-decidebar.adf-more-below::before{content:\'\';position:absolute;left:0;right:0;top:-20px;height:20px;background:linear-gradient(to top,var(--dsw-specific-input-major),transparent);pointer-events:none}'
        + '.adf-decide-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}'
        + '.adf-decide-rejected{color:var(--dsw-alias-state-error-primary)}'
        + '.adf-change-btn{font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;padding:3px 9px}'
        + '.adf-change-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}'
        // When our decide bar owns the ask, hide the native card's own
        // Allow/Reject row (the element after the scroll body) so there is
        // exactly one decision surface.
        + '[data-approval-scroll]:has(.adf-decidebar) + div{display:none}'
        + '.adf-decide-btns{display:flex;gap:8px}'
        + '.adf-btn-decide{font:inherit;font-size:11.5px;cursor:pointer;border-radius:999px;padding:4px 12px;background:transparent}'
        + '.adf-btn-reject{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-secondary)}'
        + '.adf-btn-allow{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-secondary)}'
        + '.adf-delete-note{padding:10px 12px;font-size:12px;background:var(--dsw-alias-file-diff-deleted-bg);color:var(--dsw-alias-label-primary)}'
      document.head.appendChild(tag)

      if (typeof document.addEventListener === 'function') {
        document.addEventListener('scroll', updateDecideBars, true)
      }

      return () => {
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('scroll', updateDecideBars, true)
        }
        try { offDetail() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }
  return module.exports
} })
