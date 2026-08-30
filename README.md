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

- The pending `edit` rendered as a real diff INSIDE the native approval
  card, through the card's own `conversation.approval.detail` seat: disk-
  anchored line numbers, a context window around the change, and word-level
  highlights (via [dsh-diff-view](https://github.com/joao-paulo-santos/dsh-diff-view))
- `write` shows the new content as additions, merged against the current
  file when one exists; deletion commands (`rm` and friends) render a
  review notice so the command text gets read before allowing
- The diff is anchored to DISK TRUTH fetched at ask time from this
  package's host route; when the file cannot be read, the operands still
  render as an aligned diff with blank numbers — never lying numbers
- Decisions stay on the native card's own buttons; this plugin never
  answers anything

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
  Everything else renders no detail and stays fully native.
- Deletion review shows the command text, not the deleted content.
- Requires dsh 0.1.2+ (the pending-interaction approval model). The v0.20
  composer takeover, batch decisions, and per-file answer buttons are
  retired — the native card owns decisions now.

## Dependencies

- [dsh-diff-view](https://github.com/joao-paulo-santos/dsh-diff-view) owns the diff engine and stylesheet this plugin renders its review cards with (required; the plugin does not activate without it)

## Plugins dependent on this

*(none yet)*
