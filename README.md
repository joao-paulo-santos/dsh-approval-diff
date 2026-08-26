# dsh-approval-diff

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: install it into a profile alongside your own plugins.

**See what you approve.** When the model asks permission to change a file, the
native card shows the tool arguments: `old_string` and `new_string` as raw
text, no file context, no line numbers. This plugin replaces that ask with a
real diff review: red and green lines side by side, word-level highlights
inside changed lines, surrounding file content with true line numbers, and
exactly two buttons.

## Plugin value proposition

<img width="1931" height="909" alt="image" src="https://github.com/user-attachments/assets/dcd8fc25-db70-4cb4-9ce2-9d7ffb11cfa6" />

| alternative | falls short |
|---|---|
| the native approval card | raw tool arguments; you reconstruct the diff in your head, every ask |
| reading the file yourself | you become the diff engine, and the model already read it once |
| auto-approve and hope | no review at all |

## What you get

- True line diffs for `edit`: LCS line matching plus word-level highlights;
  unchanged lines inside an edit's operands render as context, not as changes
- Split or Unified view (GitHub style toggle, choice remembered); unified
  groups each change run as all removed lines, then all added
- New files (`write`) render one-sided, all green; deletions (`rm` and
  friends) render the full current file in red before you decide
- Consecutive edits to the same file merge into one diff and one decision
- Two buttons, Reject and Allow, scoped to exactly what the card shows
- Requests that cannot succeed are never shown to you
- Minimize collapses the card without deciding; the close button hands that
  request back to the native card

## How to install

Requires a DeepSeek Harness checkout and a profile, here `web`. Clone the
plugin into a plugins folder:

```sh
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
git clone https://github.com/joao-paulo-santos/dsh-approval-diff.git

# from the harness checkout
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-approval-diff

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Restart the harness after installing: the host half loads at boot. The
client half hot-reloads once installed.

## Limitations

- File-changing approvals only (`edit`, `write`, deletion-only `bash`).
  Everything else is the native card's job.
- Deletion review reads targets from disk; glob targets render as the
  pattern.
- One approval at a time, matching the native card's behavior.

## Dependencies

None

## Plugins dependent on this

*(none yet)*
