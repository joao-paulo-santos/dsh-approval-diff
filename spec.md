# SPEC — `dsh-approval-diff` (v0.1.0)

*Client-only plugin. You are a fresh agent with no prior context; this file is
complete. Read it fully before writing code.*

## 1. Purpose

While an approval is pending for a tool call that changes a file (`edit` or
`write`), render a **side-by-side diff panel** so the operator reviews the
change at a glance — instead of expanding the tool call in the chat history.
Today the native approval card shows a stacked (before-block, after-block)
diff; this plugin adds a two-column view. For new files, a one-sided all-green
panel ("just one side is better than expanding the tool call").

## 2. Environment facts

- **Harness checkout (read-only reference — DO NOT modify):**
  `/home/ecila/dev/deepseek-harness/`
- **This plugin's folder (build here):**
  `/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-approval-diff/`
- **Sibling plugins are style references** (`../dsh-session-square` minimal
  clean example; `../dsh-notifications` for a client bundle with state).
- **Plugin authoring guide (READ FIRST — it is the law):**
  `~/.dsh/guides/plugins/` — readme.md (golden rules), 03/04 (client
  bundles), 08-debugging.md (Cases 1–23 — hard-won failure modes you must
  not repeat), 10-reference.md, 11-communication.md.
- Install into profile: `node /home/ecila/dev/deepseek-harness/apps/cli/lib/bin.js
  plugin --profile web add /mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-approval-diff`
- Compose check: `node /home/ecila/dev/deepseek-harness/apps/cli/lib/bin.js
  --profile web --dump-config > /dev/null` (silence = composes).
- Client halves hot-reload (~1s) into the GUI at `http://127.0.0.1:3080`.
  Verify serving: `curl -s http://127.0.0.1:3080/plugins/dsh-approval-diff/client.js`.
  A harness restart is needed only if you change the host half (none here).

## 3. Package skeleton (mandatory shape)

- `package.json` — name `dsh-approval-diff`, version `0.1.0`, `"type":
  "module"`, dependency `"@deepseek-ai/cordis":
  "link:/home/ecila/dev/deepseek-harness/vendor/cordis"`. **Copy
  `../dsh-session-square/package.json` and adapt** — do not invent fields.
- `cordis.patch.yml` — one row (copy from a sibling, adapt name).
- `README.md` — purpose, install, semantics, limitations, deletion note
  (this plugin dies the day the native approval card grows a side-by-side
  toggle — it is an interim renderer, not a forever plugin).
- `lib/client.js` — the whole plugin (client-only, no host half needed, but
  keep `lib/index.js` absent-or-trivial per sibling conventions; check what
  `dsh-notifications` does with its host half and mirror the MINIMAL host
  pattern if one is required for bundle serving).

**Client bundle format (hand-authored, no build step):**

```js
window.__ModuleLoader__.load({ id: 'dsh-approval-diff', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  // ... definitions ...
  module.exports = { name: 'approval-diff-client', inject: [/* see §5 */], apply(ctx) {
    // register slot, inject style, subscribe state
    return () => { /* dispose EVERYTHING: slot reg, style tag, listeners */ }
  } }
  return module.exports
} })
```

## 4. Behavior specification

**Trigger:** a pending approval whose attached tool call is `edit` or `write`.
Discovery task (do this FIRST — it determines your inject list): find how
pending approvals/questions reach the browser UI. Start in the harness at
`packages/client/` — `ui-user-questions` (referenced by ui-conversation
contracts) and whatever renders approval cards; identify the client
service/state surface exposing pending requests with their `callId`, tool
name, and the tool call's arguments. Read-only inspection via grep/reading
the checkout. If the surface carries the full tool arguments, use them; if it
carries only `callId`, find the tool-call store that resolves arguments from
`callId`. Record what you found in the README (surface name + source file) —
the next maintainer needs it.

**Panel (renders into the `shell.overlay` seat, order 50 — squares sit at
89/90):**

- Fixed right side: `position:fixed; right:0; top:0; bottom:0; width:420px;
  z-index:9950; pointer-events:auto` (the rest of the overlay layer stays
  click-through). Theme tokens like siblings use
  (`var(--dsw-alias-label-primary)`, `var(--dsw-alias-bg-layer-1)`, …).
  Panel injected via a `<style data-plugin="dsh-approval-diff">` tag,
  removed on dispose.
- Header: file basename (bold) + full path as `title` tooltip, `+N -M` line
  counts, a close (×) button, and — when multiple approvals are pending —
  a "N more" counter (v1 shows the first pending only).
- Body: two columns, monospace 12px, line numbers on both sides, equal-height
  row alignment:
  - `edit`: left = each line of `old_string` on red-tinted rows; right = each
    line of `new_string` on green-tinted rows. Pad the shorter side with
    empty rows so lines stay aligned.
  - `write` (new file): left column shows a dimmed `(new file)` cell; right
    column = file content, all green.
- Long lines wrap (`white-space:pre-wrap; word-break:break-all`); panel body
  scrolls independently (`overflow-y:auto; scrollbar-gutter:stable` — see
  Case 23 recurrence: stable gutter prevents width jumps).
- Close button hides the panel **for this pending request only**; a newly
  pending approval re-opens it.
- Panel disappears when the request resolves (approved/rejected/cancelled)
  or the plugin unloads. It must not trap focus or interfere with the native
  approval card's interaction.

## 5. Laws (violations ship broken — Cases 16/22/23 in the guide)

1. **Inject law:** every `ctx.<service>` access declared in `inject`. Expected
   list: `['slots', <discovered pending-approval surface>]` — final list is
   whatever your §4 discovery says; EVERY name you touch must be in it.
2. **Elements law:** components render via `React.createElement(...)` only;
   never function-call a component (React #310 — Case 16).
3. **Effects law:** `useEffect` cleanup disposes everything. Any state that
   must survive a remount lives in module scope, not the component (Case 23).
4. **Naming law:** names answer "per WHAT?" — `pendingApprovals`, not `data`;
   `unsubscribe`, not `off`; `listener`, not `cb`. A function does only what
   its name admits.
5. **Reversibility:** the apply() disposer removes slot registration, style
   tag, and every subscription.

## 6. Testing (faithful harness — mandatory, Case 22)

Plain Node scripts, but the fake context MUST enforce the inject guard:

```js
const mkCtx = (injectList, provided) => {
  const declared = new Set(injectList || [])
  const ctx = { inject: injectList,
    get: (name) => (declared.has(name) ? provided[name] : undefined),
    provide: (name, api) => { provided[name] = api }, on: () => () => {} }
  for (const name of ['slots', '<discovered-surface>', 'eventRelay']) {
    Object.defineProperty(ctx, name, { get() {
      if (!declared.has(name)) throw new Error('cannot get property "' + name + '" without inject')
      return provided[name]
    } })
  }
  return ctx
}
```

Required assertions (drive your components with a fake React that executes
effects and stores state per hook index — see sibling test patterns and
`08-debugging.md`):
- mis-declared access THROWS (assert it)
- no pending → no panel; pending edit with differing line counts → two
  columns, aligned rows, correct +/- counts; pending write → one-sided green
- resolution → panel unmounts; close button → hidden for that request only;
  a second pending → header counter
- plugin teardown disposes style tag + subscriptions

## 7. Delivery checklist

1. Package complete, all tests green, installed into profile `web`,
   `--dump-config` composes, bundle served at the /plugins/ URL.
2. README documents: the discovered approval surface (name + file), the
   trigger conditions, limitations (v1: first pending only; edit/write only),
   and the deletion condition (native side-by-side toggle ships).
3. Append any NEW failure mode you hit to
   `~/.dsh/guides/plugins/08-debugging.md` as the next numbered Case; fix any
   guide inaccuracy you find, in place.
4. Report: files, test summary, the discovered surface, open questions.
