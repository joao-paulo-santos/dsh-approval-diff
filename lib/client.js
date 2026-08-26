/**
 * dsh-approval-diff — browser half (hand-authored client bundle), v0.4.
 *
 * The approval review lives IN THE SESSION CHAT: this bundle registers a
 * selector-routed entry in the 'conversation.composer' chain (the same
 * mechanism, and the same seat, as the native approval card —
 * ui-conversation's ApprovalPanel, which registers with priority: 1). Our
 * entry registers with priority: 0 and DECLINES everything that is not a
 * FILE-CHANGING approval, so:
 *
 *   - pending edit / write / deletion-only bash approval -> OUR review card
 *     replaces the input bar: header (+N/-M, zero counts hidden), the diff
 *     body (two-sided edit; one-sided all-green create; one-sided all-red
 *     deletion review with content as last seen in-window), and a footer
 *     with Reject / Allow once wired through the carrier's respond() using
 *     the exact native wire encoding;
 *   - anything else (non-file bash, ask-user questions, plan review) falls
 *     through to the shipped card, unchanged;
 *   - the × button dismisses OUR card for this request only — the chain
 *     then elects the native card for it (the escape hatch).
 *
 * Cross-session: the takeover is per-session by construction. An approval
 * landing in a session you are not watching stays pending (the runtime
 * buffers answerable requested frames and replays them when the session is
 * opened; the sidebar amber dot marks the session), and is decided when
 * you come back to that session's chat. v0.3's global side panel is GONE
 * by decision — a global "awaiting approval" surface may come later.
 *
 * Deletion review (rm/unlink/rmdir/shred): the trigger parses the command
 * (every &&/;/newline segment deletes, or is a no-op echo/printf sidecar
 * with no shell metacharacters); the content shown per target is the newest
 * in-window read result or write call for that path (by event seq, read
 * gutters stripped), labeled with its staleness caveat — the window's truth,
 * never a guess.
 *
 * The chain selector is PURE (a pure function of the owner props; the core
 * re-runs it per render). Carrier registration and per-request memory
 * (dismiss/latch/error maps) happen in the COMPONENT, not the selector.
 */
window.__ModuleLoader__.load({ id: 'dsh-approval-diff', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')

  // ---- constants -----------------------------------------------------------

  const COMPOSER_SEAT = 'conversation.composer'
  /** Below the shipped ApprovalPanel's priority: 1 — ascending order elects us first. */
  const COMPOSER_PRIORITY = 0
  const FILE_TOOL_NAMES = ['edit', 'write']
  const DELETION_COMMAND_NAMES = ['rm', 'unlink', 'rmdir', 'shred']
  /** File-context lines shown before/after each edited region (v0.5.1). */
  const EDIT_CONTEXT_LINE_COUNT = 3

  // ---- per-request memory (module scope: survives remounts; guide Case 23) --

  const panelListeners = new Set()
  const notifyPanelListeners = () => { for (const listener of panelListeners) { try { listener() } catch (e) {} } }

  /** Review tabs the operator dismissed (ours hides; the native card takes over for those requests). */
  const dismissedReviewTabs = new Map()      // tabKey -> sessionId
  /** Review tabs the operator MINIMIZED (collapsed to the header strip; still ours, still pending). */
  const minimizedReviewTabs = new Map()      // tabKey -> sessionId

  /** One review tab = one session + one file (raw path string as the model wrote it). */
  const reviewTabKeyOf = (sessionId, filePath) => sessionId + '|' + filePath

  const dismissReviewTab = (tabKey, sessionId) => {
    dismissedReviewTabs.set(tabKey, sessionId)
    notifyPanelListeners()
  }

  /** Collapse/expand one file tab (minimize is NOT a decision). */
  const toggleReviewTabMinimized = (tabKey, sessionId) => {
    if (minimizedReviewTabs.has(tabKey)) minimizedReviewTabs.delete(tabKey)
    else minimizedReviewTabs.set(tabKey, sessionId)
    notifyPanelListeners()
  }
  /** Answer path: requestKey -> the live pending-approval carrier (respond()). */
  const approvalCarriers = new Map()
  /** One-shot answer latch per request key (experience state; guide Case 23). */
  const answeredApprovalKeys = new Map()       // requestKey -> sessionId
  /** Per-request answer failure text (shown in the footer; cleared on retry). */
  const answerErrors = new Map()               // requestKey -> { sessionId, message }

  /**
   * PRE-DECIDED BATCH ANSWERS (v0.9): the user decides the whole batch with
   * one click; each queued call's outcome is delivered AUTOMATICALLY the
   * instant its approval frame arrives (respond() on the live wire — the
   * protocol sequence stays intact; only the click is batched). Keyed by
   * callId; cleared on delivery, cancellation, or settlement elsewhere.
   */
  const preDecidedAnswers = new Map()          // callId -> { outcome, sessionId }

  const cancelPreDecidedAnswers = () => {
    if (preDecidedAnswers.size === 0) return
    preDecidedAnswers.clear()
    notifyPanelListeners()
  }

  /** Cancel only the pre-decisions of one outcome (the pill's own ×). */
  const cancelPreDecidedAnswersOfOutcome = (outcome) => {
    let cancelled = false
    for (const [callId, armed] of [...preDecidedAnswers]) {
      if (armed.outcome === outcome) { preDecidedAnswers.delete(callId); cancelled = true }
    }
    if (cancelled) notifyPanelListeners()
  }

  /**
   * One click, whole batch: live pendings are answered NOW; queued siblings
   * are armed for automatic delivery when their asks arrive.
   */
  const answerBatch = async (outcome, entries) => {
    for (const entry of entries) {
      if (entry.status === 'pending') {
        await answerApproval(entry.approvalRow.requestKey, outcome)
      } else if (entry.approvalRow.callId !== undefined && entry.approvalRow.callId !== '') {
        preDecidedAnswers.set(entry.approvalRow.callId, { outcome, sessionId: entry.approvalRow.sessionId })
      }
    }
    notifyPanelListeners()
  }

  // ---- host-side context (v0.6: deterministic, zero model involvement) -----

  /**
   * Disk truth per absolute path, fetched at approval time from the host
   * route (GET /approval-diff/context). While an edit/write approval pends,
   * the disk IS the pre-change state — perfect context without the model
   * reading anything. Transcript recovery remains the fallback.
   */
  const hostFileContexts = new Map()           // absPath -> { status, contentLines }

  /** Failed host reads retry on later renders, but no sooner than this (no fetch spam). */
  const HOST_CONTEXT_RETRY_MS = 2000

  const requestHostFileContext = (absolutePath, freshnessKey) => {
    if (absolutePath === undefined) return
    const existing = hostFileContexts.get(absolutePath)
    if (existing !== undefined) {
      // Idempotent while pending, or ready AND still fresh. A NEW approval
      // for the same path (freshnessKey = the live request key) re-reads the
      // file: sequential edits each see the post-previous-edit disk state
      // (a cached stale copy once left the second edit unanchored — found in
      // the wild, numbering the hunk 1..N under the file's first lines).
      if (existing.status === 'loading') return
      if (existing.status === 'ready' && existing.freshnessKey === freshnessKey) return
      if (existing.status === 'failed' && Date.now() - existing.failedAt < HOST_CONTEXT_RETRY_MS) return
    }
    hostFileContexts.set(absolutePath, { status: 'loading', contentLines: null })
    if (typeof fetch !== 'function') {
      hostFileContexts.set(absolutePath, { status: 'failed', contentLines: null, failedAt: Date.now() })
      return
    }
    fetch('/approval-diff/context?path=' + encodeURIComponent(absolutePath))
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        hostFileContexts.set(absolutePath, body !== null && typeof body === 'object'
          && typeof body.content === 'string'
          ? { status: 'ready', contentLines: splitLines(body.content), freshnessKey }
          : { status: 'failed', contentLines: null, failedAt: Date.now() })
      }, () => {
        hostFileContexts.set(absolutePath, { status: 'failed', contentLines: null, failedAt: Date.now() })
      })
      .then(() => { notifyPanelListeners() })
  }

  /** The best DISK-sourced lines for a path, or undefined (absent/failed/loading). */
  const hostContentLinesOf = (absolutePath) => {
    const record = hostFileContexts.get(absolutePath)
    return record !== undefined && record.status === 'ready' ? record.contentLines : undefined
  }

  const messageOf = (error) => (error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error))

  /**
   * Deliver the operator's decision for one pending request — the same wire
   * encoding the native ApprovalPanel's PendingApproval.answer uses. The
   * one-shot latch disables both buttons until the broadcast resolved frame
   * drops the wait (the chain then falls through and our card unmounts) or
   * the response is refused (re-armed for retry, reason shown). A user
   * decision never throws.
   */
  const answerApproval = async (requestKey, outcome) => {
    const carrier = approvalCarriers.get(requestKey)
    if (carrier === undefined || answeredApprovalKeys.has(requestKey)) return
    if (typeof carrier.respond !== 'function') return
    answeredApprovalKeys.set(requestKey, carrier.sessionId)
    answerErrors.delete(requestKey)
    notifyPanelListeners()
    try {
      const receipt = await carrier.respond({
        ok: true,
        value: {
          sessionId: carrier.sessionId,
          approvalId: carrier.payload.approvalId,
          outcome,
        },
      })
      if (receipt !== null && typeof receipt === 'object' && receipt.accepted !== true) {
        throw new Error(typeof receipt.reason === 'string' && receipt.reason !== ''
          ? receipt.reason
          : 'the response was not accepted')
      }
    } catch (error) {
      // Re-arm for retry and surface the reason; the wait is still pending.
      answeredApprovalKeys.delete(requestKey)
      answerErrors.set(requestKey, { sessionId: carrier.sessionId, message: messageOf(error) })
    }
    notifyPanelListeners()
  }

  /**
   * Drop per-request and per-tab memory of THIS session's waits that are no
   * longer pending (tab keys drop when the file has no live request left).
   */
  const pruneResolvedRequests = (liveRequestKeys, liveTabKeys, sessionId) => {
    for (const [tabKey, recordSessionId] of [...dismissedReviewTabs]) {
      if (recordSessionId === sessionId && !liveTabKeys.has(tabKey)) dismissedReviewTabs.delete(tabKey)
    }
    for (const [tabKey, recordSessionId] of [...minimizedReviewTabs]) {
      if (recordSessionId === sessionId && !liveTabKeys.has(tabKey)) minimizedReviewTabs.delete(tabKey)
    }
    for (const [requestKey, recordSessionId] of [...answeredApprovalKeys]) {
      if (recordSessionId === sessionId && !liveRequestKeys.has(requestKey)) answeredApprovalKeys.delete(requestKey)
    }
    for (const [requestKey, record] of [...answerErrors]) {
      if (record.sessionId === sessionId && !liveRequestKeys.has(requestKey)) answerErrors.delete(requestKey)
    }
    for (const [requestKey, carrier] of [...approvalCarriers]) {
      if (carrier.sessionId === sessionId && !liveRequestKeys.has(requestKey)) approvalCarriers.delete(requestKey)
    }
  }

  // ---- pure helpers ---------------------------------------------------------

  /** Split text into lines (CRLF-normalized); a trailing newline ends the last line, it does not open an empty one. */
  const splitLines = (text) => {
    const normalized = String(text).replace(/\r\n/g, '\n')
    if (normalized === '') return []
    const parts = normalized.split('\n')
    return normalized.endsWith('\n') ? parts.slice(0, -1) : parts
  }

  /** Last non-empty path segment (both separators accepted, trailing separators ignored). */
  const baseNameOf = (path) => {
    const raw = String(path)
    const segments = raw.replace(/[/\\]+$/, '').split(/[/\\]/)
    return segments[segments.length - 1] !== '' ? segments[segments.length - 1] : raw
  }

  /** Parse a running call's argsRaw into a plain object, or null (unparseable / not an object). */
  const parseToolArguments = (argsRaw) => {
    try {
      const parsed = JSON.parse(argsRaw)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (e) { return null }
  }

  /**
   * Whether one command segment is a NO-OP OBSERVABILITY SIDECAR: a bare
   * echo/printf with no shell metacharacters (no redirection, substitution,
   * or chaining — any of those could write files or run more commands). Such
   * segments cannot delete anything, so `rm x && echo done` still reviews
   * every deletion truthfully.
   */
  const isNoOpSidecarSegment = (segment) => {
    if (/[>$()<>;|&`\\]/.test(segment)) return false
    const tokens = segment.trim().split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0) return false
    let firstIndex = 0
    while (firstIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[firstIndex])) firstIndex += 1
    const commandTokens = tokens.slice(firstIndex)
    if (commandTokens.length === 0) return false
    return ['echo', 'printf'].includes(baseNameOf(commandTokens[0])) && commandTokens.length > 1
  }

  /**
   * Parse ONE command segment as a deletion command.
   * @returns `{ commandName, flags, targets }`, or undefined when the segment
   *   does anything other than delete (non-deletion verb, no targets).
   */
  const deletionFromSegment = (segment) => {
    const tokens = segment.trim().split(/\s+/).filter((token) => token !== '')
    let firstIndex = 0
    while (firstIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[firstIndex])) firstIndex += 1
    const commandTokens = tokens.slice(firstIndex)
    if (commandTokens.length === 0) return undefined
    const commandName = baseNameOf(commandTokens[0])
    if (!DELETION_COMMAND_NAMES.includes(commandName)) return undefined
    const flags = []
    const targets = []
    let flagsEnded = false
    for (let index = 1; index < commandTokens.length; index++) {
      const token = commandTokens[index]
      if (!flagsEnded && token === '--') { flagsEnded = true; continue }
      if (!flagsEnded && token.startsWith('-') && token !== '-') { flags.push(token); continue }
      targets.push(token)
    }
    if (targets.length === 0) return undefined
    return { commandName, flags, targets }
  }

  /**
   * The deletion review trigger for a full command line: only when every
   * non-empty segment (`&&`/`;`/newline-separated) either deletes or is a
   * no-op observability sidecar, and at least one deletes. Genuinely mixed
   * commands (effectful sidecars, pipes, unknown verbs) decline — a partial
   * review would understate what the command does.
   * @returns `{ commandName, flags, targets, commandText }`, or undefined.
   */
  const deletionOfCommand = (commandText) => {
    if (typeof commandText !== 'string' || commandText.trim() === '') return undefined
    if (commandText.includes('|')) return undefined
    const segments = commandText.split(/&&|;|\n/).map((segment) => segment.trim()).filter((s) => s !== '')
    if (segments.length === 0) return undefined
    const commandNames = new Set()
    const flags = []
    const targets = []
    for (const segment of segments) {
      const deletion = deletionFromSegment(segment)
      if (deletion === undefined) {
        if (!isNoOpSidecarSegment(segment)) return undefined
        continue
      }
      commandNames.add(deletion.commandName)
      for (const flag of deletion.flags) if (!flags.includes(flag)) flags.push(flag)
      for (const target of deletion.targets) if (!targets.includes(target)) targets.push(target)
    }
    if (commandNames.size === 0) return undefined
    return {
      commandText,
      commandName: commandNames.size === 1 ? [...commandNames][0] : 'rm',
      flags,
      targets,
    }
  }

  /**
   * One plain-data approval row from a PendingWait<'approval'> carrier plus
   * the session's running calls — PURE (no carrier registration, no memory
   * writes; the selector uses this). Reads only leaf fields.
   */
  const approvalRowFromWait = (wait, runningCalls) => {
    if (wait === null || typeof wait !== 'object' || wait.kind !== 'approval') return undefined
    const payload = wait.payload
    if (payload === null || typeof payload !== 'object') return undefined
    const callId = typeof payload.callId === 'string' ? payload.callId : undefined
    const runningCall = callId === undefined
      ? undefined
      : runningCalls.find((call) => call !== null && typeof call === 'object' && call.callId === callId)
    const args = runningCall !== undefined && typeof runningCall.argsRaw === 'string'
      ? parseToolArguments(runningCall.argsRaw)
      : null
    const toolName = typeof payload.toolName === 'string' && payload.toolName !== ''
      ? payload.toolName
      : runningCall !== undefined && typeof runningCall.name === 'string' ? runningCall.name : ''
    return {
      requestKey: typeof wait.key === 'string' ? wait.key : '',
      sessionId: typeof wait.sessionId === 'string' ? wait.sessionId : '',
      approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : '',
      toolName,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      callId,
      args,
    }
  }

  /**
   * Which review kind an approval row triggers: 'edit' | 'write' |
   * 'deletion', or undefined (decline — the native card serves it).
   */
  const reviewKindOfApprovalRow = (approvalRow) => {
    if (approvalRow === undefined || approvalRow.args === null) return undefined
    if (FILE_TOOL_NAMES.includes(approvalRow.toolName)) {
      const filePath = approvalRow.args.file_path
      if (typeof filePath !== 'string' || filePath === '') return undefined
      if (approvalRow.toolName === 'edit') {
        return typeof approvalRow.args.old_string === 'string' && typeof approvalRow.args.new_string === 'string'
          ? 'edit'
          : undefined
      }
      return typeof approvalRow.args.content === 'string' ? 'write' : undefined
    }
    if (approvalRow.toolName === 'bash' && typeof approvalRow.args.command === 'string') {
      return deletionOfCommand(approvalRow.args.command) !== undefined ? 'deletion' : undefined
    }
    return undefined
  }

  /** Lexically normalize and absolutize a path under the session cwd (no node:path in the browser). */
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

  // ---- the diff engine (v0.5: real diffs, not operand echo) ---------------

  /**
   * Longest-common-subsequence edit operations ('=' shared, '-' only-before,
   * '+' only-after) over two item lists, or null when the DP table would
   * exceed the area cap (callers own the fallback).
   */
  const lcsOperationList = (beforeItems, afterItems, itemsEqual, areaCap) => {
    const beforeCount = beforeItems.length
    const afterCount = afterItems.length
    if (beforeCount * afterCount > areaCap) return null
    const widths = afterCount + 1
    const table = new Int32Array((beforeCount + 1) * widths)
    for (let beforeIndex = beforeCount - 1; beforeIndex >= 0; beforeIndex--) {
      for (let afterIndex = afterCount - 1; afterIndex >= 0; afterIndex--) {
        table[beforeIndex * widths + afterIndex] = itemsEqual(beforeItems[beforeIndex], afterItems[afterIndex])
          ? table[(beforeIndex + 1) * widths + afterIndex + 1] + 1
          : Math.max(
            table[(beforeIndex + 1) * widths + afterIndex],
            table[beforeIndex * widths + afterIndex + 1])
      }
    }
    const operations = []
    let beforeIndex = 0
    let afterIndex = 0
    while (beforeIndex < beforeCount && afterIndex < afterCount) {
      if (itemsEqual(beforeItems[beforeIndex], afterItems[afterIndex])) {
        operations.push('=')
        beforeIndex += 1
        afterIndex += 1
      } else if (table[(beforeIndex + 1) * widths + afterIndex]
        >= table[beforeIndex * widths + afterIndex + 1]) {
        operations.push('-')
        beforeIndex += 1
      } else {
        operations.push('+')
        afterIndex += 1
      }
    }
    while (beforeIndex < beforeCount) { operations.push('-'); beforeIndex += 1 }
    while (afterIndex < afterCount) { operations.push('+'); afterIndex += 1 }
    return operations
  }

  /**
   * Aligned diff rows between the edit command's two operands — the review
   * shows what actually CHANGED, never the operands echoed side by side:
   *   'same'    identical line inside the matched region -> neutral context on
   *             BOTH sides (manual-testing feedback: context is not an edit);
   *   'replace' a removed line paired with an added one -> red left, green
   *             right, plus the intra-line word diff (see wordSpansOfLinePair);
   *   'delete'  removed only; 'insert' added only (the shorter side pads).
   * Line-level LCS; a size-cap fallback pairs index-wise without word diff
   * (still a real diff: trailing extras become pure delete/insert rows).
   */
  const alignedEditRowsOf = (removedLines, addedLines) => {
    const operations = lcsOperationList(removedLines, addedLines, (a, b) => a === b, 4000000)
    const rows = []
    const removedRun = []
    const addedRun = []
    const flushRun = () => {
      const pairCount = Math.min(removedRun.length, addedRun.length)
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        rows.push({ kind: 'replace', removedLine: removedRun[pairIndex], addedLine: addedRun[pairIndex] })
      }
      for (let extraIndex = pairCount; extraIndex < removedRun.length; extraIndex++) {
        rows.push({ kind: 'delete', removedLine: removedRun[extraIndex] })
      }
      for (let extraIndex = pairCount; extraIndex < addedRun.length; extraIndex++) {
        rows.push({ kind: 'insert', addedLine: addedRun[extraIndex] })
      }
      removedRun.length = 0
      addedRun.length = 0
    }
    if (operations === null) {
      const pairCount = Math.min(removedLines.length, addedLines.length)
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        rows.push({ kind: 'replace', removedLine: removedLines[pairIndex], addedLine: addedLines[pairIndex] })
      }
      for (let extraIndex = pairCount; extraIndex < removedLines.length; extraIndex++) {
        rows.push({ kind: 'delete', removedLine: removedLines[extraIndex] })
      }
      for (let extraIndex = pairCount; extraIndex < addedLines.length; extraIndex++) {
        rows.push({ kind: 'insert', addedLine: addedLines[extraIndex] })
      }
      return rows
    }
    let beforeIndex = 0
    let afterIndex = 0
    for (const operation of operations) {
      if (operation === '=') {
        flushRun()
        rows.push({ kind: 'same', removedLine: removedLines[beforeIndex], addedLine: addedLines[afterIndex] })
        beforeIndex += 1
        afterIndex += 1
      } else if (operation === '-') {
        removedRun.push(removedLines[beforeIndex])
        beforeIndex += 1
      } else {
        addedRun.push(addedLines[afterIndex])
        afterIndex += 1
      }
    }
    flushRun()
    return rows
  }

  /** One line's word tokens: each word with its trailing whitespace attached. */
  const wordTokensOf = (line) => {
    const tokens = String(line).match(/\S+\s*/g)
    return tokens === null ? [] : tokens
  }

  /**
   * Intra-line word spans for one replaced line pair: tokens outside the
   * sides' word LCS carry `changed` and get the strong word highlight
   * (red on the removed word, green on the added word) while unchanged
   * words stay plain — "a word added here, a word deleted there" reads as
   * exactly that. Size-cap fallback marks the whole line changed.
   * @returns `{ removedSpans, addedSpans }` — arrays of `{ text, changed }`.
   */
  const wordSpansOfLinePair = (removedLine, addedLine) => {
    const removedTokens = wordTokensOf(removedLine)
    const addedTokens = wordTokensOf(addedLine)
    const tokenKey = (token) => token.replace(/\s+$/, '')
    const operations = lcsOperationList(removedTokens, addedTokens, (a, b) => tokenKey(a) === tokenKey(b), 250000)
    if (operations === null) {
      return {
        removedSpans: [{ text: String(removedLine), changed: true }],
        addedSpans: [{ text: String(addedLine), changed: true }],
      }
    }
    const removedSpans = []
    const addedSpans = []
    let beforeIndex = 0
    let afterIndex = 0
    for (const operation of operations) {
      if (operation === '=') {
        removedSpans.push({ text: removedTokens[beforeIndex], changed: false })
        addedSpans.push({ text: addedTokens[afterIndex], changed: false })
        beforeIndex += 1
        afterIndex += 1
      } else if (operation === '-') {
        removedSpans.push({ text: removedTokens[beforeIndex], changed: true })
        beforeIndex += 1
      } else {
        addedSpans.push({ text: addedTokens[afterIndex], changed: true })
        afterIndex += 1
      }
    }
    return { removedSpans, addedSpans }
  }

  /** Whether `lines` contains `span` as a consecutive run (first occurrence index, or -1). */
  const indexOfLineSpan = (lines, span) => {
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

  /** The raw file key an approval row groups under (the path exactly as the model wrote it). */
  const fileKeyOfApprovalRow = (approvalRow) => {
    if (approvalRow.args === null) return undefined
    if (FILE_TOOL_NAMES.includes(approvalRow.toolName)) {
      return typeof approvalRow.args.file_path === 'string' && approvalRow.args.file_path !== ''
        ? approvalRow.args.file_path
        : undefined
    }
    if (approvalRow.toolName === 'bash' && typeof approvalRow.args.command === 'string') {
      const command = deletionOfCommand(approvalRow.args.command)
      return command !== undefined ? command.targets[0] : undefined
    }
    return undefined
  }

  /**
   * The renderable file change for one approval row, or undefined. CONTEXT
   * IS NOT COMPUTED HERE (v0.7): the body anchors hunks against the DISK
   * lines at render time — the only context source (a prior read may lack
   * the surrounding lines, so transcript recovery is gone by design).
   */
  const fileChangeOfApprovalRow = (approvalRow) => {
    const reviewKind = reviewKindOfApprovalRow(approvalRow)
    if (reviewKind === undefined) return undefined
    if (reviewKind === 'deletion') {
      const command = deletionOfCommand(approvalRow.args.command)
      // Content resolves from DISK at render time (the body owns the cwd).
      const sections = command.targets.map((target) => ({ targetPath: target }))
      return {
        reviewKind: 'deletion',
        filePath: command.targets[0],
        isNewFile: false,
        removedLines: [],
        addedLines: [],
        removedCount: 0,
        addedCount: 0,
        deletion: { ...command, sections },
      }
    }
    const filePath = approvalRow.args.file_path
    if (reviewKind === 'edit') {
      const removedLines = splitLines(approvalRow.args.old_string)
      const addedLines = splitLines(approvalRow.args.new_string)
      const editRows = alignedEditRowsOf(removedLines, addedLines)
      // Counts are CHANGES, not operand sizes: a replaced line counts once on
      // each side; same-context lines inside the matched region count zero.
      const replaceCount = editRows.filter((row) => row.kind === 'replace').length
      return {
        reviewKind: 'edit',
        filePath,
        isNewFile: false,
        editRows,
        oldOperandLines: removedLines,
        replaceAll: approvalRow.args.replace_all === true,
        removedCount: replaceCount + editRows.filter((row) => row.kind === 'delete').length,
        addedCount: replaceCount + editRows.filter((row) => row.kind === 'insert').length,
      }
    }
    const addedLines = splitLines(approvalRow.args.content)
    return {
      reviewKind: 'write',
      filePath,
      isNewFile: true,
      removedLines: [],
      addedLines,
      removedCount: 0,
      addedCount: addedLines.length,
    }
  }

  // ---- review tabs: one per file, aggregating the whole batch (v0.7/v0.8) ----

  /** The active review tab's file key (experience state; guide Case 23). */
  let activeReviewTabKey = undefined
  /** Edit view mode for two-sided reviews: 'split' (default) or 'unified'. Experience state (guide Case 23). */
  let editViewMode = 'split'

  /** Every chat node value, defensively (the window's nodes). */
  const chatNodeValuesOf = (snapshot) => (snapshot !== null && typeof snapshot === 'object'
    && snapshot.chat && snapshot.chat.nodes && typeof snapshot.chat.nodes.values === 'function'
    ? snapshot.chat.nodes.values()
    : [])

  /**
   * The OWNING STEP's tool-call blocks: the assistant chat node that contains
   * `callId`. A finalized step carries EVERY tool call of the batch up front
   * (the scheduler then executes them one-by-one — exclusive calls form
   * barriers), so the queued siblings are reviewable the moment the FIRST
   * approval pends (the trajectory tab renders the same batch).
   * REAL SHAPE (verified in source, ui-conversation assistant.ts /
   * chat-nodes.ts): the chat node kind is 'assistant-step' and the blocks
   * live at `data.blocks` as AssistantBlock[] — `{ kind: 'tool-call',
   * callId, name, argsRaw }`. The reader is defensive about the wrapper
   * (node.data ?? node) and both block spellings (AssistantBlock's
   * kind/callId/argsRaw and the raw ContentBlock's type/id/arguments),
   * because an assumed shape here once shipped the batch preview dead
   * (found live in round-9 testing — the fake had encoded the assumption).
   * @returns normalized `{ callId, name, argsRaw }[]` of that step, or [].
   */
  const stepToolCallBlocksOf = (snapshot, callId) => {
    for (const node of chatNodeValuesOf(snapshot)) {
      if (node === null || typeof node !== 'object') continue
      if (node.kind !== 'assistant' && node.kind !== 'assistant-step') continue
      const data = node.data !== undefined && node.data !== null ? node.data : node
      const rawBlocks = Array.isArray(data.blocks) ? data.blocks : []
      const toolCallBlocks = []
      for (const block of rawBlocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.kind === 'tool-call' && typeof block.callId === 'string') {
          toolCallBlocks.push({ callId: block.callId, name: block.name, argsRaw: block.argsRaw })
        } else if (block.type === 'tool-call' && typeof block.id === 'string') {
          toolCallBlocks.push({ callId: String(block.id), name: block.name, argsRaw: block.arguments })
        }
      }
      if (toolCallBlocks.some((block) => block.callId === callId)) return toolCallBlocks
    }
    return []
  }

  /** callIds that already have a committed result (applied or rejected-and-returned). */
  const settledCallIdsOf = (snapshot) => {
    const settled = new Set()
    for (const node of chatNodeValuesOf(snapshot)) {
      const root = node !== null && typeof node === 'object' && node.data !== null && typeof node.data === 'object'
        ? node.data.root
        : undefined
      if (root !== null && typeof root === 'object' && root.kind === 'tool-result'
        && typeof root.callId === 'string') {
        settled.add(root.callId)
      }
    }
    return settled
  }

  /**
   * v0.17 — ONE FILE PER CARD, CONTIGUOUS RUNS ONLY (manual-testing decision).
   *
   * The card reviews exactly the pending call's file, plus the QUEUED
   * siblings that form a CONTIGUOUS same-file run behind it:
   *
   *   [edit1 f1, edit2 f1, (anything else…)]  -> ONE card for f1 (edit1+edit2)
   *   [edit f1, edit f3, edit f1]             -> f1's card merges the leading
   *                                              run only; the later f1 edit
   *                                              gets its own card at its turn.
   *
   * Why contiguous-only: (a) an approval must be SELF-CONTAINED — nothing the
   * operator clicks may be stranded behind an unrelated pending decision
   * (the overnight rule: leave f3 pending and file1 silently misses an edit
   * the user believed was applied); (b) same-file runs can never be un-askable
   * (the observation gate is per-file: a pending frame for f1 proves f1 is
   * observed, so every same-file sibling passes it too) — the phantom-tab
   * class existed only cross-file and stops being rendered; (c) if the file
   * changes mid-run, the run's later edits fail their version CAS anyway —
   * "if one would fail they would likely all fail" (manual testing).
   * The run is also SAME-KIND (v0.17.1): an rm of the same file is a
   * different KIND of decision — it must never join an edit run (its
   * deletion precedence would repaint the card all-red and hide the hunks).
   *
   * Entries: 'pending' (answerable now) and 'queued' (next in line, armed by
   * the two buttons, delivered automatically as each frame arrives).
   * Content precedence: deletion > edits (aggregated as hunks) > write.
   * @returns `{ tabs: [{ tabKey, filePath, entries, editHunks, deletion, write, queuedCount }] }`.
   */
  const buildReviewTabs = (matched, snapshot, sessionCwd) => {
    const runningCalls = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.runningCalls)
      ? snapshot.runningCalls
      : []
    const pendingWaits = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.pending)
      ? snapshot.pending
      : []
    const sessionId = typeof matched.sessionId === 'string' ? matched.sessionId : ''

    // Index the live pendings by callId (the answerable set).
    const pendingByCallId = new Map()
    for (const pendingWait of pendingWaits) {
      if (pendingWait === null || typeof pendingWait !== 'object' || pendingWait.kind !== 'approval') continue
      const approvalRow = approvalRowFromWait(pendingWait, runningCalls)
      if (approvalRow === undefined || approvalRow.callId === undefined) continue
      pendingByCallId.set(approvalRow.callId, { wait: pendingWait, approvalRow })
    }

    // The batch: the owning step's tool-call blocks (found via the matched
    // carrier's callId; falls back to just the pendings when not in-window).
    const matchedRow = pendingByCallId.get(typeof matched.payload === 'object' ? matched.payload.callId : undefined)
    const matchedCallId = matchedRow !== undefined ? matchedRow.approvalRow.callId : undefined
    const stepBlocks = matchedCallId !== undefined
      ? stepToolCallBlocksOf(snapshot, matchedCallId)
      : []
    const settledCallIds = settledCallIdsOf(snapshot)

    // The matched pending itself (this file's live ask).
    const matchedFileKey = matchedRow !== undefined ? fileKeyOfApprovalRow(matchedRow.approvalRow) : undefined
    if (matchedRow === undefined || matchedFileKey === undefined) return { tabs: [] }
    const matchedFileChange = fileChangeOfApprovalRow(matchedRow.approvalRow)
    if (matchedFileChange === undefined) return { tabs: [] }
    const matchedReviewKind = matchedFileChange.reviewKind

    const tabs = []
    const appendEntry = (wait, approvalRow, status) => {
      const fileChange = fileChangeOfApprovalRow(approvalRow)
      if (fileChange === undefined) return
      const fileKey = fileKeyOfApprovalRow(approvalRow)
      if (fileKey === undefined) return
      if (dismissedReviewTabs.has(reviewTabKeyOf(approvalRow.sessionId, fileKey))) return
      let tab = tabs[0]
      if (tab === undefined) {
        tab = {
          tabKey: reviewTabKeyOf(approvalRow.sessionId, fileKey),
          filePath: fileKey,
          entries: [],
          editHunks: [],
          deletion: undefined,
          write: undefined,
          queuedCount: 0,
        }
        tabs.push(tab)
      }
      tab.entries.push({ wait, approvalRow, fileChange, status })
      if (status === 'queued') tab.queuedCount += 1
      if (fileChange.reviewKind === 'deletion' && tab.deletion === undefined) {
        tab.deletion = fileChange
        tab.deletionStatus = status
      } else if (fileChange.reviewKind === 'edit') {
        tab.editHunks.push({ wait, approvalRow, fileChange, status })
      } else if (fileChange.reviewKind === 'write' && tab.write === undefined) {
        tab.write = fileChange
        tab.writeStatus = status
      }
    }

    appendEntry(matchedRow.wait, matchedRow.approvalRow, 'pending')

    // The CONTIGUOUS same-file run: walk the step's model order from the
    // matched call forward, stopping at the FIRST call that is not an
    // unsettled call on the SAME file. Settled calls break the run (their
    // approval moment has passed); a different file breaks it (its decision
    // must not be hosted on this card).
    if (stepBlocks.length > 0) {
      const startIndex = stepBlocks.findIndex((block) => block.callId === matchedCallId)
      if (startIndex >= 0) {
        for (let index = startIndex + 1; index < stepBlocks.length; index++) {
          const block = stepBlocks[index]
          if (block === undefined || settledCallIds.has(block.callId)) break
          const pseudoWait = {
            kind: 'approval',
            key: 'queued:' + block.callId,
            sessionId,
            payload: { approvalId: '', toolName: block.name, callId: block.callId },
          }
          const approvalRow = approvalRowFromWait(pseudoWait,
            [{ callId: block.callId, name: block.name, argsRaw: block.argsRaw }])
          if (approvalRow === undefined) break
          if (fileKeyOfApprovalRow(approvalRow) !== matchedFileKey) break
          // SAME KIND too (v0.17.1, found in manual testing): an `rm` of the
          // SAME file passes the file check — without this, the deletion
          // joins the tab and the card's deletion-precedence flips the whole
          // review into the all-red deletion view, burying the edit hunks.
          // A different KIND OF CHANGE on the same file is a different
          // decision and gets its own card at its own turn.
          const siblingFileChange = fileChangeOfApprovalRow(approvalRow)
          if (siblingFileChange === undefined || siblingFileChange.reviewKind !== matchedReviewKind) break
          if (dismissedReviewTabs.has(reviewTabKeyOf(approvalRow.sessionId, matchedFileKey))) break
          appendEntry(pseudoWait, approvalRow, 'queued')
        }
      }
    }
    return { tabs }
  }

  // ---- the chain selector (PURE — runs per render of the composer owner) ----

  /**
   * Claim the composer for the first pending approval that is a file-changing
   * review we can render (edit / write with resolvable arguments, or a
   * deletion-only bash command) and whose FILE TAB the operator has not
   * dismissed. Declines (null) otherwise, so the shipped ApprovalPanel
   * (priority: 1) serves everything else exactly as before — including
   * whole dismissed tabs.
   * @param ownerProps - the composer chain currency
   *   `{ interactions: PendingInteraction[], session: ConversationSnapshot | undefined }`.
   * @returns the matching ApprovalWait carrier, or null.
   */
  const selectFileApprovalReview = (ownerProps) => {
    const interactions = ownerProps !== null && typeof ownerProps === 'object'
      && Array.isArray(ownerProps.interactions)
      ? ownerProps.interactions
      : []
    if (interactions.length === 0) return null
    const session = ownerProps !== null && typeof ownerProps === 'object' ? ownerProps.session : undefined
    const runningCalls = session !== null && typeof session === 'object' && Array.isArray(session.runningCalls)
      ? session.runningCalls
      : []
    for (const interaction of interactions) {
      if (interaction === null || typeof interaction !== 'object' || interaction.kind !== 'approval') continue
      const approvalRow = approvalRowFromWait(interaction, runningCalls)
      if (approvalRow === undefined) continue
      if (reviewKindOfApprovalRow(approvalRow) === undefined) continue
      const fileKey = fileKeyOfApprovalRow(approvalRow)
      if (fileKey === undefined) continue
      const tabKey = reviewTabKeyOf(approvalRow.sessionId, fileKey)
      if (dismissedReviewTabs.has(tabKey)) continue       // that FILE fell back to the native card
      return interaction
    }
    return null
  }

  // ---- components -----------------------------------------------------------

  /** Force-update hook over the per-request memory (latch/error/dismiss changes). */
  const useReviewMemoryVersion = () => {
    const [, forceRender] = React.useState(0)
    React.useEffect(() => {
      const listener = () => forceRender((renderCount) => renderCount + 1)
      panelListeners.add(listener)
      return () => { panelListeners.delete(listener) }
    }, [])
  }

  /**
   * The composer takeover: our review card for ONE file-changing approval.
   * Elected by selectFileApprovalReview; receives `matched` (the ApprovalWait
   * carrier) plus the session standard kit (useSession, useSessions,
   * sessionId). Derives everything from the live snapshot — no watchers, no
   * stored copy of the conversation.
   */
  const ApprovalReviewComposer = (props) => {
    useReviewMemoryVersion()
    const matched = props.matched
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

    // Prune this session's per-request and per-tab memory when its waits
    // leave the snapshot.
    const pendingKeysJoined = props.useSession((snapshot) => {
      const waits = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.pending)
        ? snapshot.pending
        : []
      const runningCalls = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.runningCalls)
        ? snapshot.runningCalls
        : []
      const requestKeys = waits.map((wait) => (wait !== null && typeof wait === 'object' && typeof wait.key === 'string'
        ? wait.key
        : ''))
      const tabKeys = []
      for (const wait of waits) {
        if (wait === null || typeof wait !== 'object' || wait.kind !== 'approval') continue
        const approvalRow = approvalRowFromWait(wait, runningCalls)
        if (approvalRow === undefined || reviewKindOfApprovalRow(approvalRow) === undefined) continue
        const fileKey = fileKeyOfApprovalRow(approvalRow)
        if (fileKey !== undefined) tabKeys.push(reviewTabKeyOf(approvalRow.sessionId, fileKey))
      }
      return requestKeys.join('\u0000') + '\u0001' + tabKeys.join('\u0000')
    })
    React.useEffect(() => {
      const [requestKeysJoined, tabKeysJoined] = pendingKeysJoined.split('\u0001')
      const liveRequestKeys = new Set((requestKeysJoined ?? '').split('\u0000').filter((key) => key !== ''))
      const liveTabKeys = new Set((tabKeysJoined ?? '').split('\u0000').filter((key) => key !== ''))
      pruneResolvedRequests(liveRequestKeys, liveTabKeys, sessionId)
    }, [pendingKeysJoined, sessionId])

    // AUTO-DELIVERY of pre-decided batch answers: derive (during render) the
    // pendings whose callId is armed and not yet answered, plus armed callIds
    // that settled without us (stale); the effect delivers / cleans them.
    const armedDeliveryJoined = props.useSession((snapshot) => {
      if (preDecidedAnswers.size === 0) return ''
      const waits = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.pending)
        ? snapshot.pending
        : []
      const toDeliver = []
      for (const wait of waits) {
        if (wait === null || typeof wait !== 'object' || wait.kind !== 'approval') continue
        const callId = wait.payload !== null && typeof wait.payload === 'object'
          && typeof wait.payload.callId === 'string'
          ? wait.payload.callId
          : undefined
        if (callId === undefined) continue
        const armed = preDecidedAnswers.get(callId)
        if (armed === undefined) continue
        if (typeof wait.key === 'string' && !answeredApprovalKeys.has(wait.key)) {
          toDeliver.push({ callId, requestKey: wait.key, outcome: armed.outcome })
        }
      }
      const settled = settledCallIdsOf(snapshot)
      const stale = [...preDecidedAnswers.keys()].filter((callId) => settled.has(callId))
      return JSON.stringify({ toDeliver, stale })
    })
    React.useEffect(() => {
      if (armedDeliveryJoined === '') return
      const { toDeliver, stale } = JSON.parse(armedDeliveryJoined)
      for (const callId of stale) preDecidedAnswers.delete(callId)
      for (const delivery of toDeliver) {
        preDecidedAnswers.delete(delivery.callId)
        void answerApproval(delivery.requestKey, delivery.outcome)
      }
    }, [armedDeliveryJoined])

    const sessionCwd = props.useSessions((listState) => {
      const summary = listState !== null && typeof listState === 'object' && listState.byId !== null
        && typeof listState.byId === 'object'
        ? listState.byId[sessionId]
        : undefined
      return summary !== null && typeof summary === 'object' && typeof summary.cwd === 'string'
        ? summary.cwd
        : undefined
    })

    const review = props.useSession((snapshot) => buildReviewTabs(matched, snapshot, sessionCwd))

    // Register the answer carrier of EVERY tab entry (idempotent; keyed by
    // the request identity) so the footer can answer the active tab's set.
    for (const tab of review.tabs) {
      for (const entry of tab.entries) {
        const entryWait = entry.wait
        if (entryWait !== null && typeof entryWait === 'object' && typeof entryWait.respond === 'function'
          && typeof entryWait.key === 'string' && entryWait.key !== '') {
          approvalCarriers.set(entryWait.key, entryWait)
        }
      }
    }

    // Pull disk truth for EVERY involved path (edit targets + deletion
    // targets, all tabs) — an idempotent render-time cache fill (a Map
    // probe per path; failures retry on a later render, never in a loop).
    // Deterministic context; the model reads nothing.
    const contextPaths = []
    for (const tab of review.tabs) {
      if (tab.deletion !== undefined) {
        for (const target of tab.deletion.deletion.targets) {
          contextPaths.push(absolutePathUnder(sessionCwd, target))
        }
      } else {
        contextPaths.push(absolutePathUnder(sessionCwd, tab.filePath))
      }
    }
    for (const contextPath of contextPaths) {
      // Freshness key = the live request: a NEW approval for the same path
      // re-reads the disk (sequential edits must not share a stale copy).
      requestHostFileContext(contextPath, matched.key)
    }

    if (review.tabs.length === 0) {
      // Elected but momentarily underivable (e.g. the paired call left the
      // window). Never render null — that would blank the composer area. The
      // decision stays possible through the native card (our card is absent,
      // the chain falls through on the next pass) — so this is a transient
      // one-render notice only.
      return React.createElement('div', { className: 'adf-composerwrap' },
        React.createElement('div', { className: 'adf-composer adf-notice' },
          React.createElement('div', { className: 'adf-notice-text' },
            'Review unavailable — the standard approval card follows.')))
    }

    // v0.14.2 — CERTAIN DOOM IS INVISIBLE (manual-testing law: "never even
    // show it"). A tab whose precheck PROVES failure is removed from the
    // card entirely — no tab, no banner, no disabled button. Its pending
    // requests are quietly allowed in the effect below, so the harness's own
    // gate produces the genuine error the model learns from (the gates run
    // BEFORE any mutation, so a doomed allow cannot change the file); its
    // queued entries simply never surface. The ONLY fallback: if the forward
    // itself errors (respond failed), the tab resurfaces for a manual
    // decision — otherwise the request would pend invisibly forever.
    const doomedTabKeysJoined = props.useSession((snapshot) => review.tabs
      .filter((tab) => tab.deletion === undefined
        && editPrecheckOf(tab, snapshot, sessionCwd).ok !== true)
      .map((tab) => tab.tabKey)
      .join('\u0000'))
    const doomedTabKeys = doomedTabKeysJoined === '' ? [] : doomedTabKeysJoined.split('\u0000')

    // v0.17 makes phantom tabs impossible by construction: the card contains
    // exactly ONE tab (the pending call's contiguous same-file run), so there
    // is nothing cross-file to filter and no prediction surface at all.
    const erroredDoomedTabKeys = review.tabs
      .filter((tab) => doomedTabKeys.includes(tab.tabKey)
        && tab.entries.some((entry) => entry.status === 'pending'
          && answerErrors.has(entry.approvalRow.requestKey)))
      .map((tab) => tab.tabKey)
    const visibleTabs = review.tabs
      .filter((tab) => !doomedTabKeys.includes(tab.tabKey) || erroredDoomedTabKeys.includes(tab.tabKey))
    // Forward every DOOMED tab's pending requests (all tabs, not just the
    // one that would have been active). Entries the operator explicitly
    // pre-decided (armed) are left to the armed-delivery effect — an
    // explicit user choice outranks our convenience forward.
    const doomedRequestKeys = doomedTabKeys.length === 0 ? ''
      : review.tabs
          .filter((tab) => doomedTabKeys.includes(tab.tabKey))
          .flatMap((tab) => tab.entries)
          .filter((entry) => entry.status === 'pending'
            && !answeredApprovalKeys.has(entry.approvalRow.requestKey)
            && !(entry.approvalRow.callId !== undefined && preDecidedAnswers.has(entry.approvalRow.callId)))
          .map((entry) => entry.approvalRow.requestKey)
          .join('\u0000')
    React.useEffect(() => {
      for (const requestKey of doomedRequestKeys.split('\u0000').filter((key) => key !== '')) {
        void answerApproval(requestKey, 'allowed-once')
      }
    }, [doomedRequestKeys])

    // Active tab: the operator's sticky choice, else the first (auto-advances
    // when a tab's requests resolve or are dismissed away). When EVERY tab is
    // doomed (none visible), the doomed list stands in so the hook chain
    // below stays unconditional — the null return right after it discards
    // the result anyway.
    const tabPool = visibleTabs.length > 0 ? visibleTabs : review.tabs
    let activeTab = tabPool.find((tab) => tab.tabKey === activeReviewTabKey)
    if (activeTab === undefined) activeTab = tabPool[0]
    activeReviewTabKey = activeTab.tabKey

    const activeHunks = activeTab.editHunks
    const removedTotal = (activeTab.deletion !== undefined ? activeTab.deletion.removedCount : 0)
      + activeHunks.reduce((total, hunk) => total + hunk.fileChange.removedCount, 0)
    const addedTotal = (activeTab.write !== undefined ? activeTab.write.addedCount : 0)
      + activeHunks.reduce((total, hunk) => total + hunk.fileChange.addedCount, 0)
    const minimized = minimizedReviewTabs.has(activeTab.tabKey)
    // Pre-approval success check against the disk copy fetched at approval
    // time (v0.13) — for the ACTIVE (visible, non-doomed) tab this feeds the
    // heuristic WARN banner only; certain doom never gets this far (filtered
    // above). The one exception: an ERRORED forward fallback tab, whose
    // precheckBlocked state disables Allow and shows the manual banner.
    const precheck = activeTab.deletion === undefined
      ? props.useSession((snapshot) => editPrecheckOf(activeTab, snapshot, sessionCwd))
      : { ok: true, blockReasons: [], warnReasons: [] }
    const precheckBlocked = precheck !== null && typeof precheck === 'object' && precheck.ok !== true
    // Every tab is doomed and none errored: there is NOTHING to show. The
    // forwards run in the effect above; rendering null (not a notice) is the
    // point — the operator sees nothing at all.
    if (visibleTabs.length === 0) return null
    // The InputBar capsule footprint (mirrors the native ApprovalPanel root:
    // a centered wrapper, then the card on the shared content width — "a
    // content swap, not a layout jump"). data-minimized collapses the card
    // to its header strip (CSS hides body/footer) so the chat stays
    // readable while the request pends — minimize is NOT a decision.
    return React.createElement('div', { className: 'adf-composerwrap' },
      React.createElement('div', {
        className: 'adf-composer',
        'data-approval-key': activeTab.entries[0].approvalRow.requestKey,
        'data-hunk-count': String(activeHunks.length),
        'data-tab-count': String(visibleTabs.length),
        'data-minimized': minimized ? '1' : '0',
      },
        React.createElement(ApprovalPanelHeader, {
          key: 'head',
          tabs: visibleTabs,
          activeTabKey: activeTab.tabKey,
          onSelectTab: (tabKey) => {
            activeReviewTabKey = tabKey
            notifyPanelListeners()
          },
          filePath: activeTab.filePath,
          headerTitle: activeTab.deletion !== undefined ? activeTab.deletion.deletion.commandText : activeTab.filePath,
          commandBadge: activeTab.deletion !== undefined
            ? activeTab.deletion.deletion.commandName
              + (activeTab.deletion.deletion.flags.length > 0
                ? ' ' + activeTab.deletion.deletion.flags.join(' ')
                : '')
            : undefined,
          addedCount: addedTotal,
          removedCount: removedTotal,
          isEditReview: activeTab.deletion === undefined && activeHunks.length > 0,
          // The file suffix renders ONLY with no tab strip: one file has no
          // tabs to carry its identity, so the header must (manual-testing
          // feedback — with tabs it was duplicate, without them it vanished).
          singleFileName: review.tabs.length > 1 ? undefined : activeTab.filePath,
          viewMode: editViewMode,
          onSelectViewMode: (mode) => {
            editViewMode = mode
            notifyPanelListeners()
          },
          minimized,
          onToggleMinimize: () => { toggleReviewTabMinimized(activeTab.tabKey, matched.sessionId) },
          onClose: () => { dismissReviewTab(activeTab.tabKey, matched.sessionId) },
        }),
        precheckBlocked
          ? React.createElement('div', {
              key: 'precheck-block',
              className: 'adf-precheck adf-precheck-block',
              role: 'alert',
            },
            '\u26a0 auto-forward failed — this change cannot succeed, decide manually:',
            React.createElement('ul', { className: 'adf-precheck-list' },
              precheck.blockReasons.map((reason, index) => React.createElement('li', { key: index }, reason))))
          : null,
        precheck.warnReasons.length > 0
          ? React.createElement('div', {
              key: 'precheck-warn',
              className: 'adf-precheck adf-precheck-warn',
            },
            '\u26a0 ' + precheck.warnReasons.join('; '))
          : null,
        React.createElement(ApprovalDiffBody, {
          key: 'body',
          tab: activeTab,
          sessionCwd,
        }),
        React.createElement(ApprovalPanelActions, {
          key: 'actions',
          tabEntries: activeTab.entries,
          precheckBlocked,
        })))
  }

  const ApprovalPanelHeader = (props) => {
    const headerRow = React.createElement('div', { className: 'adf-head' },
      React.createElement('div', { className: 'adf-head-file', title: props.headerTitle },
        // The card title is REVIEW-related (manual-testing feedback): file
        // identity lives in the TABS; the tooltip still carries the path.
        React.createElement('span', { className: 'adf-head-title' }, 'Review pending changes'),
        props.commandBadge !== undefined
          ? React.createElement('span', { className: 'adf-more', title: 'deletion command' }, props.commandBadge)
          : null,
        props.singleFileName !== undefined
          ? React.createElement('span', { className: 'adf-head-basename' }, baseNameOf(props.singleFileName))
          : null),
      React.createElement('div', { className: 'adf-head-side' },
        // Zero counts hide (manual-testing feedback): a one-sided review never
        // shows "+0" or "-0" — the absent side is not information.
        props.addedCount > 0
          ? React.createElement('span', { className: 'adf-count adf-count-add' }, '+' + props.addedCount)
          : null,
        props.removedCount > 0
          ? React.createElement('span', { className: 'adf-count adf-count-del' }, '-' + props.removedCount)
          : null,
        // Split / Unified toggle (GitHub-style) — only for two-sided EDITS
        // (creates and deletions are inherently single-column).
        props.isEditReview
          ? React.createElement('div', {
              className: 'adf-viewtoggle',
              role: 'group',
              'aria-label': 'Diff view mode',
            },
            React.createElement('button', {
              type: 'button',
              className: 'adf-viewbtn' + (props.viewMode === 'split' ? ' adf-viewbtn-active' : ''),
              title: 'Split view — old and new side by side',
              'aria-pressed': props.viewMode === 'split' ? 'true' : 'false',
              onClick: () => { props.onSelectViewMode('split') },
            }, 'Split'),
            React.createElement('button', {
              type: 'button',
              className: 'adf-viewbtn' + (props.viewMode === 'unified' ? ' adf-viewbtn-active' : ''),
              title: 'Unified view — one column with - and + lines',
              'aria-pressed': props.viewMode === 'unified' ? 'true' : 'false',
              onClick: () => { props.onSelectViewMode('unified') },
            }, 'Unified'))
          : null,
        React.createElement('button', {
          type: 'button',
          className: 'adf-close',
          'aria-label': props.minimized ? 'Expand the review card' : 'Minimize the review card',
          title: props.minimized ? 'Expand (review stays pending)' : 'Minimize to read the chat; review stays pending',
          onClick: props.onToggleMinimize,
        }, props.minimized ? '\u25b8' : '\u25be'),
        React.createElement('button', {
          type: 'button',
          className: 'adf-close',
          'aria-label': 'Use the standard approval card for this request',
          title: 'Use the standard approval card instead',
          onClick: props.onClose,
        }, '\u00d7')))
    // FILE TABS (v0.7): one per file with pending requests. A file whose
    // every entry is armed for the same outcome shows its decision STATE
    // (v0.11): greenish with a check when allowed, reddish with a cross when
    // rejected — changeable on the tab until delivery.
    const tabDecisionOf = (tab) => {
      if (tab.entries.length === 0) return undefined
      let outcome
      for (const entry of tab.entries) {
        if (entry.status === 'pending') return undefined
        const armed = entry.approvalRow.callId !== undefined
          ? preDecidedAnswers.get(entry.approvalRow.callId)
          : undefined
        if (armed === undefined) return undefined
        if (outcome === undefined) outcome = armed.outcome
        else if (outcome !== armed.outcome) return undefined
      }
      return outcome
    }
    // v0.17: with exactly one tab per card the strip can never render; the
    // code remains for the (impossible today) multi-tab future, guarded off.
    const tabsRow = props.tabs !== undefined && props.tabs.length > 1 && false
      ? React.createElement('div', { className: 'adf-tabs', role: 'tablist' },
        props.tabs.map((tab) => {
          const decision = tabDecisionOf(tab)
          const decisionClass = decision === 'allowed-once' ? ' adf-tab-allowed'
            : decision === 'rejected' ? ' adf-tab-rejected' : ''
          const decisionMark = decision === 'allowed-once' ? ' \u2713'
            : decision === 'rejected' ? ' \u2715' : ''
          return React.createElement('button', {
            type: 'button',
            key: tab.tabKey,
            role: 'tab',
            'aria-selected': tab.tabKey === props.activeTabKey ? 'true' : 'false',
            className: 'adf-tab' + (tab.tabKey === props.activeTabKey ? ' adf-tab-active' : '') + decisionClass,
            title: tab.filePath + (decision !== undefined
              ? (decision === 'allowed-once' ? ' — allowed (waiting its turn)' : ' — rejected (waiting its turn)')
              : ''),
            onClick: () => { props.onSelectTab(tab.tabKey) },
          },
            React.createElement('span', { className: 'adf-tab-name' }, baseNameOf(tab.filePath)),
            tab.entries.length > 1
              ? React.createElement('span', { className: 'adf-tab-badge' }, String(tab.entries.length))
              : null,
            decision !== undefined
              ? React.createElement('span', { className: 'adf-tab-mark' }, decisionMark)
              : null)
        }))
      : null
    return React.createElement('div', { className: 'adf-headwrap' }, headerRow, tabsRow)
  }

  /** Render word spans: changed tokens get the strong highlight class, unchanged stay plain text. */
  const wordSpanElements = (spans, highlightClass) => spans.map((span, spanIndex) => (span.changed
    ? React.createElement('span', { key: 'w' + spanIndex, className: highlightClass }, span.text)
    : span.text))

  /** Grid class for the two-sided edit layouts (split vs unified). */
  const editGridClass = () => (editViewMode === 'unified' ? 'adf-grid-unified' : 'adf-grid-twoside')

  // ---- pre-approval success check (v0.13, soundness-scoped in v0.13.1) ----
  //
  // The harness gates edits at EXECUTION time (after approval) on a version
  // compare-and-swap (FS_STALE_VERSION) and operand matching. The card holds
  // DISK TRUTH fetched at approval time, so it can predict SOME certain
  // failures before the operator spends a decision — but ONLY soundly:
  //   - STALE: content comparison is valid ONLY against a WRITE call's
  //     content (exact by construction) when it is the LATEST observation of
  //     the path. A READ's rendered output (line gutters, offset/limit
  //     windows, truncation framing) is NOT the raw file — comparing it to
  //     disk in v0.13.0 produced permanent false "stale" banners and wrongly
  //     disabled Allow (fixed in v0.13.1). Reads/edits now count as
  //     observations that INVALIDATE the write-basis (their version stamp is
  //     newer than the write's content) and produce no stale verdict.
  //   - MISSING / AMBIGUOUS: the pending edit's old_string against current
  //     disk — sound regardless of version (a missing operand fails even on
  //     a fresh version; a present one is necessary, not sufficient).
  // QUEUED hunks are exempt: their basis is the post-prior-edit file, which
  // current disk cannot show (a missing operand there is expected, not a
  // failure). NOT-OBSERVED is heuristic (the host's set may hold an
  // out-of-window read) → warn only, never block.

  /** Count how many positions `span` occurs at in `lines` (all start offsets). */
  const countLineSpanOccurrences = (lines, span) => {
    if (span.length === 0) return 0
    let count = 0
    const matchLimit = lines.length - span.length
    for (let startIndex = 0; startIndex <= matchLimit; startIndex++) {
      let matched = true
      for (let spanIndex = 0; spanIndex < span.length; spanIndex++) {
        if (lines[startIndex + spanIndex] !== span[spanIndex]) { matched = false; break }
      }
      if (matched) count += 1
    }
    return count
  }

  /**
   * The LATEST in-window observation of a path — any completed read, write,
   * or edit on it (these are the events that stamp the harness's version
   * CAS). Only a WRITE carries reconstructible content (its call argument);
   * reads render (gutters/windows), edits mutate without exposing the full
   * post-state here — both simply supersede an older write as the basis.
   * @returns `{ seq, kind, contentLines? }` (contentLines only for 'write'),
   *   or undefined when the window saw the path never.
   */
  const latestObservationOf = (snapshot, cwd, targetPath) => {
    let best = undefined
    for (const node of chatNodeValuesOf(snapshot)) {
      const root = node !== null && typeof node === 'object' && node.data !== null && typeof node.data === 'object'
        ? node.data.root
        : undefined
      if (root === null || typeof root !== 'object' || root.kind !== 'tool-result' || root.call === null) continue
      const name = root.call.name
      if (name !== 'read' && name !== 'write' && name !== 'edit') continue
      const callArguments = parseToolArguments(root.call.argsRaw)
      if (callArguments === null || typeof callArguments.file_path !== 'string') continue
      if (absolutePathUnder(cwd, callArguments.file_path) !== absolutePathUnder(cwd, targetPath)) continue
      if (best !== undefined && root.seq <= best.seq) continue
      best = name === 'write' && typeof callArguments.content === 'string' && callArguments.content !== ''
        ? { seq: root.seq, kind: 'write', contentLines: splitLines(callArguments.content) }
        : { seq: root.seq, kind: name }
    }
    return best
  }

  /**
   * The success verdict for a tab's edits. `{ ok, blockReasons[], warnReasons[] }` —
   * blockReasons are CERTAIN failures (v0.14.2: the tab is filtered from the
   * card and its pending requests auto-forwarded); warnReasons render as the
   * amber banner on an otherwise normal card.
   *
   * v0.15.0 — the NEVER-OBSERVED layer is GONE. dsh-approval-first now owns
   * that class at the source: it probes the harness's own read-first gate
   * before asking, so an unobserved edit target never generates an approval
   * at all (no card to predict on), and the native ask ordering already
   * guarantees any edit ask that reaches a card passed the gate. The mirror
   * that used to live here (fs/observed listener + /observed route) was a
   * client-side replica of host state — removed as wrong-layer once the
   * authoritative fix landed (see the approval-first spec,
   * spec-unobserved-skip.md).
   *
   * What remains is what only THIS plugin can see, none of it session state:
   *   - MISSING/AMBIGUOUS operand — the edit's own old_string vs the disk
   *     copy the card fetched (pending hunks only: a queued edit's operand
   *     basis is the post-prior-edit file).
   *   - WRITE-BASIS staleness — the latest in-window observation is a write
   *     whose exact call content differs from disk (version CAS cannot match).
   * Window-blind (observation undefined) is deliberately SILENT: post-fix,
   * the ask itself proves the gate passed.
   */
  const editPrecheckOf = (tab, snapshot, sessionCwd) => {
    const pendingHunks = tab.editHunks.filter((hunk) => hunk.status === 'pending')
    if (pendingHunks.length === 0) return { ok: true, blockReasons: [], warnReasons: [] }
    const absolutePath = absolutePathUnder(sessionCwd, tab.filePath)
    const blockReasons = []
    const warnReasons = []
    const diskLines = hostContentLinesOf(absolutePath)
    if (diskLines === undefined) {
      return { ok: true, blockReasons: [], warnReasons: ['disk content unavailable — success cannot be predicted'] }
    }
    const observation = latestObservationOf(snapshot, sessionCwd, tab.filePath)
    if (observation !== undefined && observation.kind === 'write') {
      // Sound staleness: the write's exact content vs the disk just fetched.
      const sameContent = observation.contentLines.length === diskLines.length
        && observation.contentLines.every((line, index) => line === diskLines[index])
      if (!sameContent) {
        blockReasons.push('the file changed since this session last wrote it — approval would fail (stale version); the model must re-read it')
      }
    }
    // kind 'read'/'edit'/undefined: no sound stale verdict (rendered/mutated
    // or out-of-window content is not reconstructible here) — deliberately
    // silent rather than guessing.
    for (const hunk of pendingHunks) {
      const occurrences = countLineSpanOccurrences(diskLines, hunk.fileChange.oldOperandLines)
      if (occurrences === 0) {
        blockReasons.push('the text to replace is no longer in the file')
      } else if (occurrences > 1 && !hunk.fileChange.replaceAll) {
        blockReasons.push('the text to replace appears ' + occurrences + ' times (edit requires exactly one, or replace_all)')
      }
    }
    return { ok: blockReasons.length === 0, blockReasons, warnReasons }
  }

  const ApprovalDiffBody = (props) => {
    const tab = props.tab
    const sessionCwd = props.sessionCwd
    const cells = []
    // PLACEMENT LAW (v0.3.1): every cell carries EXPLICIT gridColumn/gridRow
    // and the grid template is chosen per layout — a 2-column one-sided grid
    // for create/deletion, a 4-column grid for edit (guide Case 28).
    if (tab.deletion !== undefined) {
      // One-sided, all red: per target a full-width path row (with the
      // "(deleted)" marker inside it), then the content FROM DISK (the only
      // source — a pending rm means the file still exists to be read).
      let row = 1
      tab.deletion.deletion.sections.forEach((section, sectionIndex) => {
        const diskLines = hostContentLinesOf(absolutePathUnder(sessionCwd, section.targetPath))
        cells.push(React.createElement('div', {
          key: 'path-' + sectionIndex,
          className: 'adf-path',
          style: { gridColumn: '1 / -1', gridRow: String(row) },
          title: diskLines === undefined ? 'content not available' : 'content as currently on disk',
        },
          React.createElement('span', { className: 'adf-path-target' }, section.targetPath),
          React.createElement('span', { className: 'adf-deleted-badge' }, '(deleted)')))
        row += 1
        if (diskLines === undefined) {
          cells.push(React.createElement('div', {
            key: 'unseen-' + sectionIndex,
            className: 'adf-cell adf-dim',
            style: { gridColumn: '1 / -1', gridRow: String(row) },
          }, '(content unavailable)'))
          row += 1
        } else {
          diskLines.forEach((lineText, lineIndex) => {
            cells.push(React.createElement('div', {
              key: 'ln-' + sectionIndex + '-' + lineIndex,
              className: 'adf-num',
              style: { gridColumn: '1', gridRow: String(row) },
            }, String(lineIndex + 1)))
            cells.push(React.createElement('div', {
              key: 'lc-' + sectionIndex + '-' + lineIndex,
              className: 'adf-cell adf-del',
              style: { gridColumn: '2', gridRow: String(row) },
            }, lineText))
            row += 1
          })
        }
      })
      return React.createElement('div', { className: 'adf-body' },
        React.createElement('div', { className: 'adf-grid adf-grid-oneside' }, cells))
    }
    if (tab.write !== undefined && tab.editHunks.length === 0) {
      const fileChange = tab.write
      const queuedClass = tab.writeStatus === 'queued' ? ' adf-queued' : ''
      // One-sided, all green: a "(new file)" row, then every content line
      // full-width. No second side exists.
      cells.push(React.createElement('div', {
        key: 'new-file-row',
        className: 'adf-cell adf-newfile' + queuedClass,
        style: { gridColumn: '1 / -1', gridRow: '1' },
      }, '(new file)'))
      fileChange.addedLines.forEach((lineText, lineIndex) => {
        const row = String(lineIndex + 2)
        cells.push(React.createElement('div', {
          key: 'ln-' + lineIndex,
          className: 'adf-num',
          style: { gridColumn: '1', gridRow: row },
        }, String(lineIndex + 1)))
        cells.push(React.createElement('div', {
          key: 'lc-' + lineIndex,
          className: 'adf-cell adf-add' + queuedClass,
          style: { gridColumn: '2', gridRow: row },
        }, lineText))
      })
      return React.createElement('div', { className: 'adf-body' },
        React.createElement('div', { className: 'adf-grid adf-grid-oneside' }, cells))
    }
    // Two-sided edit over the ALIGNED rows: same-context lines render neutral
    // on both sides; replaced lines are red left / green right with the exact
    // changed WORDS strongly highlighted inside; pure deletes/inserts pad the
    // absent side. One grid row per aligned row (a wrapped line grows BOTH
    // sides of its row). Old/new line numbers advance independently.
    // FILE CONTEXT (v0.5.1): when the operand was located in the file's
    // last-seen content, a few real lines render before/after the hunk
    // (neutral, dimmed) with true file line numbers on BOTH sides (context
    // is unchanged), and ellipsis rows mark a file continuing beyond them.
    /**
     * One grid row in the ACTIVE layout. Split (4-column: old | new, both
     * numbered) or UNIFIED (3-column: one number column + one content column
     * + a narrow sign gutter; '-' rows red, '+' rows green — GitHub-style).
     */
    const pushGridRow = (rowIndex, cellsForRow) => {
      const row = String(rowIndex + 1)
      if (editViewMode === 'unified') {
        const removedRow = cellsForRow.leftClass.includes('adf-del')
        const addedRow = cellsForRow.rightClass.includes('adf-add')
        const contextRow = !removedRow && !addedRow
        cells.push(React.createElement('div', {
          key: 'n-' + rowIndex,
          className: 'adf-num',
          style: { gridColumn: '1', gridRow: row },
        }, contextRow || addedRow ? (cellsForRow.newNumber === undefined ? '' : String(cellsForRow.newNumber))
          : (cellsForRow.oldNumber === undefined ? '' : String(cellsForRow.oldNumber))))
        cells.push(React.createElement('div', {
          key: 's-' + rowIndex,
          className: 'adf-sign',
          style: { gridColumn: '2', gridRow: row },
        }, removedRow ? '-' : addedRow ? '+' : ''))
        cells.push(React.createElement('div', {
          key: 'c-' + rowIndex,
          className: 'adf-cell ' + (removedRow ? 'adf-del' : addedRow ? 'adf-add' : 'adf-ctx'),
          style: { gridColumn: '3', gridRow: row },
        }, removedRow ? cellsForRow.leftContent : addedRow ? cellsForRow.rightContent
          : (cellsForRow.leftContent !== undefined ? cellsForRow.leftContent : cellsForRow.rightContent)))
        return
      }
      cells.push(React.createElement('div', {
        key: 'ln-l-' + rowIndex,
        className: 'adf-num',
        style: { gridColumn: '1', gridRow: row },
      }, cellsForRow.oldNumber === undefined ? '' : String(cellsForRow.oldNumber)))
      cells.push(React.createElement('div', {
        key: 'lc-l-' + rowIndex,
        className: 'adf-cell ' + cellsForRow.leftClass,
        style: { gridColumn: '2', gridRow: row },
      }, cellsForRow.leftContent))
      cells.push(React.createElement('div', {
        key: 'ln-r-' + rowIndex,
        className: 'adf-num',
        style: { gridColumn: '3', gridRow: row },
      }, cellsForRow.newNumber === undefined ? '' : String(cellsForRow.newNumber)))
      cells.push(React.createElement('div', {
        key: 'lc-r-' + rowIndex,
        className: 'adf-cell ' + cellsForRow.rightClass,
        style: { gridColumn: '4', gridRow: row },
      }, cellsForRow.rightContent))
    }
    // MERGED FILE WALK (v0.7): all of the tab's pending edits anchor against
    // ONE disk-sourced copy of the file and render top-to-bottom. Each file
    // line renders AT MOST ONCE — hunk A's after-context and hunk B's
    // before-context never duplicate the lines between them; an "⋯ unchanged
    // ⋯" band appears exactly where lines were SKIPPED (manual-testing
    // contract). New-side numbering carries the cumulative delta of prior
    // hunks (standard multi-hunk diff numbering).
    const diskLines = hostContentLinesOf(absolutePathUnder(sessionCwd, tab.filePath))
    const anchoredHunks = tab.editHunks
      .map((hunk) => ({
        hunk,
        anchor: diskLines !== undefined
          ? indexOfLineSpan(diskLines, hunk.fileChange.oldOperandLines)
          : -1,
      }))
      .sort((left, right) => (left.anchor < 0 ? Number.MAX_SAFE_INTEGER : left.anchor)
        - (right.anchor < 0 ? Number.MAX_SAFE_INTEGER : right.anchor))
    const contextRowFor = (text, fileLineNumber) => ({
      oldNumber: fileLineNumber,
      newNumber: fileLineNumber,
      leftClass: 'adf-ctx',
      rightClass: 'adf-ctx',
      leftContent: text,
      rightContent: text,
    })
    const ellipsisRowFor = () => ({
      leftClass: 'adf-ctx adf-ellipsis',
      rightClass: 'adf-ctx adf-ellipsis',
      leftContent: '\u22ef',
      rightContent: '\u22ef',
    })
    /**
     * Render one hunk's rows. Numbering bases: numbers when anchored
     * (oldSideBase/newSideBase), BLANK when null — an unanchored hunk (its
     * operand is not in the fetched disk copy, e.g. an earlier sequential
     * edit changed those lines) must not LIE with 1..N numbering; blank says
     * "position unknown" while the diff itself stays fully reviewable.
     *
     * UNIFIED grouping (manual-testing feedback): a contiguous run of changed
     * lines renders ALL its '-' rows first, then ALL its '+' rows (GitHub
     * hunk semantics) — not interleaved -/+ pairs.
     */
    const pushHunkRows = (hunk, oldSideBase, newSideBase) => {
      let oldLineNumber = oldSideBase
      let newLineNumber = newSideBase
      const queuedClass = hunk.status === 'queued' ? ' adf-queued' : ''
      const pendingRemovals = []
      const pendingAdditions = []
      const flushUnifiedRun = () => {
        for (const removal of pendingRemovals) {
          rowIndex += 1
          pushGridRow(rowIndex, removal)
        }
        for (const addition of pendingAdditions) {
          rowIndex += 1
          pushGridRow(rowIndex, addition)
        }
        pendingRemovals.length = 0
        pendingAdditions.length = 0
      }
      hunk.fileChange.editRows.forEach((editRow) => {
        const hasRemoved = editRow.kind !== 'insert'
        const hasAdded = editRow.kind !== 'delete'
        const oldNumber = hasRemoved && oldLineNumber !== null ? oldLineNumber : undefined
        const newNumber = hasAdded && newLineNumber !== null ? newLineNumber : undefined
        if (hasRemoved && oldLineNumber !== null) oldLineNumber += 1
        if (hasAdded && newLineNumber !== null) newLineNumber += 1
        const removedSpans = editRow.kind === 'replace'
          ? wordSpanElements(wordSpansOfLinePair(editRow.removedLine, editRow.addedLine).removedSpans, 'adf-w-del')
          : editRow.kind === 'insert' ? '' : editRow.removedLine !== undefined ? editRow.removedLine : ''
        const addedSpans = editRow.kind === 'replace'
          ? wordSpanElements(wordSpansOfLinePair(editRow.removedLine, editRow.addedLine).addedSpans, 'adf-w-add')
          : editRow.kind === 'delete' ? '' : editRow.addedLine !== undefined ? editRow.addedLine : ''
        if (editViewMode === 'unified') {
          if (editRow.kind === 'same') {
            // Context flushes any open change run, then renders itself.
            flushUnifiedRun()
            rowIndex += 1
            pushGridRow(rowIndex, {
              oldNumber,
              newNumber,
              leftClass: 'adf-same' + queuedClass,
              rightClass: 'adf-same' + queuedClass,
              leftContent: removedSpans,
              rightContent: addedSpans,
            })
            return
          }
          if (hasRemoved) {
            pendingRemovals.push({
              oldNumber,
              newNumber: undefined,
              leftClass: 'adf-del' + queuedClass,
              rightClass: 'adf-pad',
              leftContent: removedSpans,
              rightContent: '',
            })
          }
          if (hasAdded) {
            pendingAdditions.push({
              oldNumber: undefined,
              newNumber,
              leftClass: 'adf-pad',
              rightClass: 'adf-add' + queuedClass,
              leftContent: '',
              rightContent: addedSpans,
            })
          }
          return
        }
        rowIndex += 1
        pushGridRow(rowIndex, {
          oldNumber,
          newNumber,
          leftClass: (editRow.kind === 'insert' ? 'adf-pad' : editRow.kind === 'same' ? 'adf-same' : 'adf-del') + queuedClass,
          rightClass: (editRow.kind === 'delete' ? 'adf-pad' : editRow.kind === 'same' ? 'adf-same' : 'adf-add') + queuedClass,
          leftContent: removedSpans,
          rightContent: addedSpans,
        })
      })
      flushUnifiedRun()
    }
    let rowIndex = -1
    if (diskLines === undefined) {
      // Disk truth not (yet) available: render the hunks without context
      // (operand-local numbering). Still fully reviewable; the moment the
      // host read lands, the anchored rendering replaces it.
      if (anchoredHunks.length > 0) {
        rowIndex += 1
        cells.push(React.createElement('div', {
          key: 'nocontext',
          className: 'adf-ctx adf-ellipsis',
          style: { gridColumn: '1 / -1', gridRow: String(rowIndex + 1) },
        }, '(file context unavailable)'))
      }
      // No disk copy at all: numbering unknown, not 1..N.
      anchoredHunks.forEach((entry) => {
        pushHunkRows(entry.hunk, null, null)
      })
      return React.createElement('div', { className: 'adf-body' },
        React.createElement('div', { className: 'adf-grid ' + editGridClass() }, cells))
    }
    let cursor = 0                 // next unemitted disk line (0-based)
    let cumulativeDelta = 0        // new-side offset from prior hunks
    /**
     * Emit the gap between `cursor` and `gapEndExclusive`: context lines on
     * the ends, an ellipsis only when lines are skipped in the middle. The
     * file top emits no leading context; the file tail no trailing context.
     */
    const pushGapRows = (gapEndExclusive, options) => {
      const showLeading = options === undefined || options.showLeading
      const showTrailing = options === undefined || options.showTrailing
      const gapStart = cursor
      const gapLength = gapEndExclusive - gapStart
      if (gapLength <= 0) return
      if (gapLength <= 2 * EDIT_CONTEXT_LINE_COUNT) {
        for (let lineIndex = gapStart; lineIndex < gapEndExclusive; lineIndex++) {
          rowIndex += 1
          pushGridRow(rowIndex, contextRowFor(diskLines[lineIndex], lineIndex + 1))
        }
        return
      }
      if (showLeading) {
        for (let lineIndex = gapStart; lineIndex < gapStart + EDIT_CONTEXT_LINE_COUNT; lineIndex++) {
          rowIndex += 1
          pushGridRow(rowIndex, contextRowFor(diskLines[lineIndex], lineIndex + 1))
        }
      }
      rowIndex += 1
      pushGridRow(rowIndex, ellipsisRowFor())
      if (showTrailing) {
        for (let lineIndex = gapEndExclusive - EDIT_CONTEXT_LINE_COUNT; lineIndex < gapEndExclusive; lineIndex++) {
          rowIndex += 1
          pushGridRow(rowIndex, contextRowFor(diskLines[lineIndex], lineIndex + 1))
        }
      }
    }
    for (const entry of anchoredHunks) {
      if (entry.anchor < 0) continue
      const matchStart = entry.anchor
      const matchEnd = matchStart + entry.hunk.fileChange.oldOperandLines.length - 1
      pushGapRows(matchStart, cursor === 0 ? { showLeading: false, showTrailing: true } : undefined)
      pushHunkRows(entry.hunk, matchStart + 1, matchStart + 1 + cumulativeDelta)
      cumulativeDelta += entry.hunk.fileChange.editRows.filter((row) => row.kind !== 'delete').length
        - entry.hunk.fileChange.oldOperandLines.length
      cursor = matchEnd + 1
    }
    // Trailing context after the last anchored hunk (never duplicating), then
    // any unanchored hunks behind a band (operand not found on disk — e.g. an
    // earlier hunk in this batch already changed those lines).
    const unanchored = anchoredHunks.filter((entry) => entry.anchor < 0)
    pushGapRows(diskLines.length, { showLeading: true, showTrailing: false })
    cursor = diskLines.length
    if (unanchored.length > 0) {
      rowIndex += 1
      cells.push(React.createElement('div', {
        key: 'hunkgap-unanchored',
        className: 'adf-hunkgap',
        style: { gridColumn: '1 / -1', gridRow: String(rowIndex + 1) },
      }, '\u22ef edits not in the current file view (position unknown) \u22ef'))
      unanchored.forEach((entry) => { pushHunkRows(entry.hunk, null, null) })
    }
    return React.createElement('div', { className: 'adf-body' },
      React.createElement('div', { className: 'adf-grid ' + editGridClass() }, cells))
  }

  /**
   * The decision footer: exactly TWO buttons — Reject / Allow — scoped to the
   * ACTIVE TAB's file: one click decides every request of that file (live
   * pendings answer immediately; the file's queued calls are ARMED and
   * auto-delivered the instant their approval frames arrive — the wire
   * sequence stays intact; only the click is batched). The other file's
   * requests are untouched: the operator switches tabs and decides there.
   * An armed indicator with a cancel sits in the footer until every armed
   * call of this file has been delivered or settled.
   */
  const ApprovalPanelActions = (props) => {
    useReviewMemoryVersion()
    const entries = Array.isArray(props.tabEntries) ? props.tabEntries : []
    const pendingEntries = entries.filter((entry) => entry.status === 'pending')
    const requestKeys = pendingEntries.map((entry) => entry.approvalRow.requestKey)
    const nothingAnswerable = requestKeys.length === 0
    const answeredAll = requestKeys.length > 0 && requestKeys.every((key) => answeredApprovalKeys.has(key))
    const anyCarrierMissing = requestKeys.some((key) => !approvalCarriers.has(key))
    const answerError = requestKeys.map((key) => answerErrors.get(key)).find((record) => record !== undefined)
    const armedAllowCount = [...preDecidedAnswers.values()].filter((armed) => armed.outcome === 'allowed-once').length
    const armedRejectCount = [...preDecidedAnswers.values()].filter((armed) => armed.outcome === 'rejected').length
    // The ACTIVE FILE's armed decision (if any) — a queued tab shows it on
    // the buttons and can CHANGE it until delivery (v0.11).
    const tabCallIds = new Set(entries.map((entry) => entry.approvalRow.callId).filter((id) => id !== undefined))
    const tabArmed = [...preDecidedAnswers.entries()].find(([callId]) => tabCallIds.has(callId))
    const armedOutcome = tabArmed !== undefined ? tabArmed[1].outcome : undefined
    const everyEntryArmed = entries.length > 0 && entries.every((entry) => {
      if (entry.status === 'pending') return false
      const armed = entry.approvalRow.callId !== undefined
        ? preDecidedAnswers.get(entry.approvalRow.callId)
        : undefined
      return armed !== undefined && armed.outcome === armedOutcome
    })
    // A queued tab is DECIDABLE out of order: its clicks arm the callIds for
    // automatic delivery when their turns come. Live pendings answer now.
    const allEntriesQueued = entries.length > 0 && entries.every((entry) => entry.status === 'queued')
    const precheckBlocked = props.precheckBlocked === true
    // NOTE: precheckBlocked disables ONLY Allow (its own guard) — Reject stays
    // available on a doomed call: rejecting it is a legitimate user choice
    // and returns the normal "rejected; file unchanged" path.
    const buttonsDisabled = (nothingAnswerable && !everyEntryArmed && !allEntriesQueued)
      || answeredAll
      || (anyCarrierMissing && !everyEntryArmed && !allEntriesQueued)
    return React.createElement('div', { className: 'adf-actions' },
      answerError !== undefined
        ? React.createElement('span', { className: 'adf-error', title: answerError.message }, answerError.message)
        : null,
      armedAllowCount > 0
        ? React.createElement('span', {
            className: 'adf-more adf-armed-allow',
            title: 'allowed in advance: delivered automatically when its turn arrives; revisit the tab to change it',
          },
          armedAllowCount + ' queued accept' + (armedAllowCount > 1 ? 's' : ''),
          React.createElement('button', {
            type: 'button',
            className: 'adf-armed-cancel',
            'aria-label': 'Cancel the queued accepts not yet delivered',
            title: 'Cancel the queued accepts not yet delivered',
            onClick: () => { cancelPreDecidedAnswersOfOutcome('allowed-once') },
          }, '\u00d7'))
        : null,
      armedRejectCount > 0
        ? React.createElement('span', {
            className: 'adf-more adf-armed-reject',
            title: 'rejected in advance: delivered automatically when its turn arrives; revisit the tab to change it',
          },
          armedRejectCount + ' queued reject' + (armedRejectCount > 1 ? 's' : ''),
          React.createElement('button', {
            type: 'button',
            className: 'adf-armed-cancel',
            'aria-label': 'Cancel the queued rejects not yet delivered',
            title: 'Cancel the queued rejects not yet delivered',
            onClick: () => { cancelPreDecidedAnswersOfOutcome('rejected') },
          }, '\u00d7'))
        : null,
      React.createElement('button', {
        type: 'button',
        className: 'adf-btn adf-btn-reject' + (armedOutcome === 'rejected' ? ' adf-btn-armed-reject' : ''),
        disabled: everyEntryArmed && armedOutcome === 'rejected' ? false : buttonsDisabled,
        onClick: () => { void answerBatch('rejected', entries) },
      }, armedOutcome === 'rejected' ? 'Rejected \u2715' : 'Reject'),
      React.createElement('button', {
        type: 'button',
        className: 'adf-btn adf-btn-allow' + (armedOutcome === 'allowed-once' ? ' adf-btn-armed-allow' : ''),
        disabled: precheckBlocked
          || (everyEntryArmed && armedOutcome === 'allowed-once' ? false : buttonsDisabled),
        title: precheckBlocked ? 'disabled: approving would fail — see the warning above' : undefined,
        onClick: () => { void answerBatch('allowed-once', entries) },
      }, armedOutcome === 'allowed-once' ? 'Allowed \u2713' : 'Allow'))
  }

  // ---- styles ---------------------------------------------------------------

  const PANEL_CSS = [
    // The composer takeover mirrors the native ApprovalPanel footprint (a
    // content swap for the InputBar capsule, not a floating panel): a
    // centered wrapper, then the card on the shared content width with the
    // input card's own surface, capsule radius, warn border, and the
    // composer's shared body-height cap. Token fallbacks keep the card
    // legible if a token is absent.
    '.adf-composerwrap{display:flex;flex-direction:column;align-items:center;box-sizing:border-box;width:100%;padding:8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px}',
    '.adf-composer{display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;width:100%;max-width:90%;max-height:calc(100vh - 200px);max-height:calc(100dvh - 200px);border:1px solid var(--dsw-alias-state-warn-secondary, var(--dsw-alias-border-l3));border-radius:20px;background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));box-shadow:var(--dsw-shadow-lv2, 0 8px 30px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary);font-size:13px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    '.adf-headwrap{flex:none;border-bottom:1px solid var(--dsw-alias-border-l2)}',
    '.adf-head{display:flex;align-items:center;gap:10px;padding:10px 16px}',
    '.adf-head-file{flex:1;min-width:0}',
    '.adf-head-title{display:block;font-weight:700;font-size:13px}',
    '.adf-head-basename{display:block;font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // FILE TABS (v0.7): one per file with pending requests.
    '.adf-tabs{display:flex;align-items:center;gap:4px;padding:0 12px 8px;overflow-x:auto;scrollbar-width:none}',
    '.adf-tabs::-webkit-scrollbar{display:none}',
    '.adf-tab{flex:none;display:flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;line-height:1;padding:6px 10px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:transparent;border:1px solid transparent;max-width:180px}',
    '.adf-tab:hover{border-color:var(--dsw-alias-border-l2)}',
    '.adf-tab-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}',
    '.adf-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.adf-tab-badge{flex:none;font-size:10px;line-height:1;padding:2px 5px;border-radius:999px;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}',
    // Queued-tab decision state (v0.11): greenish check / reddish cross,
    // changeable on the tab until delivery.
    '.adf-tab-allowed{border-color:rgba(63,185,80,.45);background:rgba(63,185,80,.10)}',
    '.adf-tab-rejected{border-color:rgba(248,81,73,.45);background:rgba(248,81,73,.10)}',
    '.adf-tab-mark{flex:none;font-size:11px;line-height:1}',
    '.adf-tab-allowed .adf-tab-mark{color:#3fb950}',
    '.adf-tab-rejected .adf-tab-mark{color:#f85149}',
    '.adf-btn-armed-allow{opacity:.85}',
    '.adf-btn-armed-reject{opacity:.85}',
    '.adf-head-side{flex:none;display:flex;align-items:center;gap:8px}',
    '.adf-count{font-family:var(--ds-font-family-code);font-size:12px;font-weight:600}',
    '.adf-count-add{color:#3fb950}',
    '.adf-count-del{color:#f85149}',
    '.adf-viewtoggle{display:inline-flex;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;overflow:hidden}',
    '.adf-viewbtn{font:inherit;font-size:11px;line-height:1;padding:5px 9px;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:transparent;border:none}',
    '.adf-viewbtn:hover{color:var(--dsw-alias-label-primary)}',
    '.adf-viewbtn-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
    // Pre-approval success check banners (v0.13).
    '.adf-precheck{flex:none;display:flex;flex-direction:column;gap:2px;padding:8px 16px;font-size:12px;line-height:17px}',
    '.adf-precheck-block{background:rgba(248,81,73,.12);color:#f85149;border-bottom:1px solid rgba(248,81,73,.3)}',
    '.adf-precheck-warn{background:rgba(210,153,34,.10);color:#d29922;border-bottom:1px solid rgba(210,153,34,.25)}',
    '.adf-precheck-list{margin:2px 0 0;padding-left:18px}',
    '.adf-more{font-size:11px;line-height:1;padding:3px 8px;border-radius:999px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}',
    '.adf-close{font:inherit;font-size:15px;line-height:1;width:24px;height:24px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent}',
    '.adf-close:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
    // The diff body: flexes inside the CARD-level viewport cap (the card's
    // top — header, minimize button — always stays visible), scrolling as
    // ONE container (both sides move together — one grid) with the scrollbar
    // HIDDEN (a text-editor read: all reachable, nothing shown).
    '.adf-body{flex:1;min-height:120px;box-sizing:border-box;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none;padding:8px 0 8px}',
    '.adf-body::-webkit-scrollbar{display:none;width:0;height:0}',
    // Minimized: the header strip remains (identity + counts + expand); the
    // review stays pending and OURS (no fallthrough) until expanded/answered.
    '.adf-composer[data-minimized=\'1\'] .adf-body{display:none}',
    '.adf-composer[data-minimized=\'1\'] .adf-actions{display:none}',
    '.adf-grid{display:grid;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;align-content:start}',
    '.adf-grid-twoside{grid-template-columns:4ch 1fr 4ch 1fr}',
    '.adf-grid-oneside{grid-template-columns:4ch 1fr}',
    '.adf-grid-unified{grid-template-columns:4ch 1.5ch 1fr}',
    '.adf-sign{padding:0 2px 0 4px;text-align:center;color:var(--dsw-alias-label-dimmed);user-select:none}',
    '.adf-num{padding:0 6px 0 10px;text-align:right;color:var(--dsw-alias-label-dimmed);user-select:none;white-space:pre}',
    '.adf-cell{min-width:0;padding:0 16px 0 6px;white-space:pre-wrap;word-break:break-all}',
    '.adf-del{background:rgba(248,81,73,.13)}',
    '.adf-add{background:rgba(63,185,80,.13)}',
    '.adf-pad{background:transparent}',
    '.adf-same{background:transparent}',
    '.adf-ctx{background:transparent;color:var(--dsw-alias-label-tertiary)}',
    '.adf-ellipsis{opacity:.6;text-align:center;user-select:none}',
    '.adf-hunkgap{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-dimmed);border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11px;font-style:italic;padding:2px 0;user-select:none}',
    '.adf-queued{opacity:.62}',
    '.adf-w-del{background:rgba(248,81,73,.45);border-radius:3px}',
    '.adf-w-add{background:rgba(63,185,80,.45);border-radius:3px}',
    '.adf-diffview{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
    '.adf-diffview-grid{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;display:grid;grid-template-columns:44px 1fr 44px 1fr;font-family:ui-monospace,monospace;font-size:12.5px;line-height:1.55;align-content:start}',
    '.adf-diffview-grid.adf-grid-unified{grid-template-columns:44px 22px 1fr}',
    '.adf-diffview-bar{flex:none;display:flex;justify-content:flex-end;padding:0 10px 8px}',
    
    '.adf-newfile{display:flex;align-items:center;justify-content:center;font-style:italic;color:var(--dsw-alias-label-dimmed)}',
    '.adf-path{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px 2px;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}',
    '.adf-path-target{overflow:hidden;text-overflow:ellipsis}',
    '.adf-deleted-badge{flex:none;font-style:italic;color:#f85149}',
    '.adf-dim{display:flex;align-items:center;justify-content:center;font-style:italic;color:var(--dsw-alias-label-dimmed)}',
    '.adf-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:14px 16px}',
    '.adf-btn{font:inherit;font-size:12.5px;line-height:1;padding:8px 14px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l3)}',
    '.adf-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}',
    '.adf-btn:disabled{opacity:.45;cursor:default}',
    '.adf-btn-reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}',
    '.adf-btn-allow{font-weight:600;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}',
    '.adf-btn-allow:hover:not(:disabled){opacity:.9;border-color:transparent}',
    '.adf-error{flex:1;min-width:0;font-size:11px;color:#f85149;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.adf-armed{display:inline-flex;align-items:center;gap:4px;color:#d29922;border-color:var(--dsw-alias-border-l3)}',
    '.adf-armed-allow{display:inline-flex;align-items:center;gap:4px;color:#3fb950;border-color:rgba(63,185,80,.45)}',
    '.adf-armed-reject{display:inline-flex;align-items:center;gap:4px;color:#f85149;border-color:rgba(248,81,73,.45)}',
    '.adf-armed-cancel{font:inherit;font-size:12px;line-height:1;width:16px;height:16px;padding:0;border-radius:4px;cursor:pointer;color:inherit;background:transparent;border:none}',
    '.adf-armed-cancel:hover{color:var(--dsw-alias-label-primary)}',
    '.adf-notice-text{padding:14px 16px;color:var(--dsw-alias-label-tertiary);font-size:12.5px}',
  ].join('')

  // ---- plugin ---------------------------------------------------------------

  // ---- the exported DIFF VIEW (client service 'approvalDiffView') ----
  // A standalone side-by-side text diff for ANY two strings — the same
  // engine and CSS the approval panel uses (line LCS + word spans + split
  // layout), with zero approval coupling. Consumers (scratchpad diff mode,
  // replacement review) inject 'approvalDiffView' and receive:
  //   diffRowsComponent({ title, before, after }) -> Component
  // The component is self-contained (elements law; scrolls its own body).
  // CONTEXT COLLAPSE for the standalone diff (same discipline as the panel):
  // runs of unchanged rows longer than 2*CONTEXT+1 collapse to CONTEXT rows
  // on each end with an ellipsis band in the middle; no leading context at
  // the top, no trailing at the bottom. Without this a one-line change in a
  // long text renders as a wall of neutral rows (user-reported quality gap).
  const DIFF_CONTEXT_LINE_COUNT = 3

  // Split/unified view mode for standalone diffs — EXPERIENCE STATE in
  // module scope (Case 23): survives remounts; shared by every diff the
  // service renders in this tab.
  let diffViewMode = 'split'
  const diffViewListeners = new Set()
  const notifyDiffViewListeners = () => { for (const fn of diffViewListeners) { try { fn() } catch (e) {} } }

  const DiffRowsView = (props) => {
    const [, forceDiffView] = React.useState(0)
    React.useEffect(() => {
      const listener = () => forceDiffView((n) => n + 1)
      diffViewListeners.add(listener)
      return () => { diffViewListeners.delete(listener) }
    }, [])
    const rows = alignedEditRowsOf(
      String(props.before === undefined || props.before === null ? '' : props.before).split('\n'),
      String(props.after === undefined || props.after === null ? '' : props.after).split('\n'),
    )
    const CONTEXT = DIFF_CONTEXT_LINE_COUNT
    const kept = new Array(rows.length).fill(false)
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].kind === 'same') continue
      for (let near = Math.max(0, index - CONTEXT); near <= Math.min(rows.length - 1, index + CONTEXT); near += 1) {
        kept[near] = true
      }
    }
    const cells = []
    let oldNumber = 0
    let newNumber = 0
    let cellRow = 0

    const lineContentWithSpans = (row, side) => {
      if (row.kind !== 'replace') {
        return row.kind === 'same' ? row.removedLine : (row.kind === 'delete' ? row.removedLine : row.addedLine)
      }
      const spans = wordSpansOfLinePair(row.removedLine, row.addedLine)
      return wordSpanElements(side === 'removed' ? spans.removedSpans : spans.addedSpans, side === 'removed' ? 'adf-w-del' : 'adf-w-add')
    }

    const pushSplitRow = (row) => {
      cellRow += 1
      const gridRow = String(cellRow)
      const leftNumber = row.kind === 'insert' ? undefined : (oldNumber += 1)
      const rightNumber = row.kind === 'delete' ? undefined : (newNumber += 1)
      cells.push(React.createElement('div', { key: 'ln-l-' + cellRow, className: 'adf-num', style: { gridColumn: '1', gridRow } }, leftNumber === undefined ? '' : String(leftNumber)))
      cells.push(React.createElement('div', {
        key: 'lc-l-' + cellRow,
        className: 'adf-cell ' + (row.kind === 'delete' || row.kind === 'replace' ? 'adf-del' : row.kind === 'insert' ? 'adf-dim' : 'adf-ctx'),
        style: { gridColumn: '2', gridRow },
      }, lineContentWithSpans(row, 'removed')))
      cells.push(React.createElement('div', { key: 'ln-r-' + cellRow, className: 'adf-num', style: { gridColumn: '3', gridRow } }, rightNumber === undefined ? '' : String(rightNumber)))
      cells.push(React.createElement('div', {
        key: 'lc-r-' + cellRow,
        className: 'adf-cell ' + (row.kind === 'insert' || row.kind === 'replace' ? 'adf-add' : row.kind === 'delete' ? 'adf-dim' : 'adf-ctx'),
        style: { gridColumn: '4', gridRow },
      }, lineContentWithSpans(row, 'added')))
    }

    const pushUnifiedRow = (row) => {
      cellRow += 1
      const gridRow = String(cellRow)
      const isDelete = row.kind === 'delete'
      const isInsert = row.kind === 'insert'
      const number = isDelete ? (oldNumber += 1) : (newNumber += 1)
      cells.push(React.createElement('div', { key: 'un-' + cellRow, className: 'adf-num', style: { gridColumn: '1', gridRow } }, row.kind === 'same' ? String(number) : isDelete ? String(oldNumber) : String(newNumber)))
      cells.push(React.createElement('div', { key: 'us-' + cellRow, className: 'adf-sign', style: { gridColumn: '2', gridRow } }, isDelete ? '-' : isInsert ? '+' : ''))
      cells.push(React.createElement('div', {
        key: 'uc-' + cellRow,
        className: 'adf-cell ' + (isDelete ? 'adf-del' : isInsert ? 'adf-add' : 'adf-ctx'),
        style: { gridColumn: '3', gridRow },
      }, lineContentWithSpans(row, isDelete ? 'removed' : 'added')))
    }

    const pushRow = (row) => (diffViewMode === 'unified' ? pushUnifiedRow(row) : pushSplitRow(row))

    const pushEllipsis = () => {
      cellRow += 1
      cells.push(React.createElement('div', {
        key: 'gap-' + cellRow, className: 'adf-cell adf-ctx adf-ellipsis',
        style: { gridColumn: '1 / -1', gridRow: String(cellRow) },
      }, '\u22ef'))
    }
    let index = 0
    while (index < rows.length) {
      if (kept[index]) { pushRow(rows[index]); index += 1; continue }
      while (index < rows.length && !kept[index]) index += 1
      if (index < rows.length) pushEllipsis()
    }

    const grid = React.createElement('div', {
      className: diffViewMode === 'unified' ? 'adf-diffview-grid adf-grid-unified' : 'adf-diffview-grid',
    }, cells)

    // view toggle (split | unified) — the same pair the approval panel has
    // THE PANEL'S OWN CONTROL, verbatim: the segmented Split/Unified pill
    // (adf-viewtoggle + adf-viewbtn pair) — same markup, same classes, same
    // tooltips as the approval panel header, so the two surfaces read as
    // one product. Sits in a compact right-aligned bar above the grid.
    const toggle = React.createElement('div', {
      className: 'adf-viewtoggle',
      role: 'group',
      'aria-label': 'Diff view mode',
    },
    React.createElement('button', {
      type: 'button',
      className: 'adf-viewbtn' + (diffViewMode === 'split' ? ' adf-viewbtn-active' : ''),
      title: 'Split view — old and new side by side',
      'aria-pressed': diffViewMode === 'split' ? 'true' : 'false',
      onClick: () => { diffViewMode = 'split'; notifyDiffViewListeners() },
    }, 'Split'),
    React.createElement('button', {
      type: 'button',
      className: 'adf-viewbtn' + (diffViewMode === 'unified' ? ' adf-viewbtn-active' : ''),
      title: 'Unified view — one column with - and + lines',
      'aria-pressed': diffViewMode === 'unified' ? 'true' : 'false',
      onClick: () => { diffViewMode = 'unified'; notifyDiffViewListeners() },
    }, 'Unified'))

    return React.createElement('div', { className: 'adf-diffview' },
      React.createElement('div', { className: 'adf-diffview-bar' }, toggle),
      grid)
  }

  const diffViewService = {
    /** A component rendering before|after side by side with the shared engine. */
    diffRowsComponent(options) {
      if (options === null || typeof options !== 'object') throw new Error('approvalDiffView.diffRowsComponent: options object required')
      if (typeof options.before !== 'string' || typeof options.after !== 'string') {
        throw new Error('approvalDiffView.diffRowsComponent: before and after strings required')
      }
      const before = options.before
      const after = options.after
      const title = typeof options.title === 'string' && options.title !== '' ? options.title : 'Diff'
      return (props) => DiffRowsView({ ...props, before, after, title })
    },
  }

  module.exports = {
    name: 'approval-diff-client',
    // Hard dependency (guide Case 22): the slot service only — the review
    // derives everything from the composer seat's standard session kit.
    inject: ['slots'],
    apply(ctx) {
      // The exported diff view service: any consumer can render
      // side-by-side diffs with this bundle's engine (scratchpad diff mode).
      ctx.provide('approvalDiffView', diffViewService)
      // Register FIRST (a misconfigured boot throws at ctx.slots before any
      // DOM side effect), then dress the page.
      const offComposer = ctx.slots.inject(COMPOSER_SEAT, () => ctx.slots.register(
        { name: COMPOSER_SEAT, select: selectFileApprovalReview, priority: COMPOSER_PRIORITY },
        ApprovalReviewComposer))

      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-approval-diff'
      tag.textContent = PANEL_CSS
      document.head.appendChild(tag)

      return () => {
        try { offComposer() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }
  return module.exports
} })
