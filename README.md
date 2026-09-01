# pi-invoker

A [Pi](https://github.com/Earendil-Works/pi) extension that lets you run fenced code blocks from the latest assistant message directly from the TUI.

> **Security notice.** Confirmed code runs as your user with full access to your filesystem, network, and environment. There is no sandboxing or shell isolation. Review every block before confirming.

## Install

```
pi install npm:pi-invoker
```

Try without installing:

```
pi -e npm:pi-invoker
```

## Usage

| Trigger | Action |
|---|---|
| `/invoke` | Slash command — waits for the agent to finish, then opens the flow |
| `ctrl+shift+i` | Keyboard shortcut — opens immediately if the agent is idle, otherwise notifies |

Both triggers operate on the **latest assistant message only**. Earlier messages are ignored.

### Block selection

If the latest assistant message contains a single recognized block it is presented immediately for confirmation. If it contains multiple blocks a searchable picker lists all of them (tag + content preview); select one to proceed.

### Confirmation

The full block is shown with four choices:

| Choice | Meaning |
|---|---|
| **Run locally** | Execute; result shown in the extension UI only. Nothing enters agent context. |
| **Run and report** | Execute; inject a structured result report as a user message, triggering the next agent turn. |
| **Edit before running** | Open the block in an inline editor; confirmation is required again after editing. |
| **Cancel** | Dismiss without starting any process. |

Confirmation is unconditional — there is no bypass path.

### Result delivery

**Run locally** — Output and exit status are displayed in the extension UI. The agent is not notified.

**Run and report** — A plain-text user message containing JSON-encoded structured execution data is injected into the conversation, triggering the next agent turn. The message includes the language tag, submitted code, working directory, combined output, numeric exit status, and `cancelled` boolean. When output was tail-bounded an explicit truncation notice (byte and line counts) is appended. Cancelled executions are reported in this mode.

## Supported tags

| Tag(s) | Interpreter |
|---|---|
| `sh`, `shell` | `sh` |
| `bash` | `bash` |
| `zsh` | `zsh` |
| `fish` | `fish` |
| `python`, `python3`, `py` | `python3` |
| `javascript`, `js`, `node` | current `node` runtime |
| `typescript`, `ts` | current `node` runtime via native TypeScript stdin (requires Node ≥ 22.19) |

## Execution environment

- **Working directory:** the project root Pi has open.
- **Input:** code block passed via stdin. No PTY is allocated; no interactive input is forwarded.
- **Environment:** inherits the host shell environment (`process.env`).

## Error and edge-case behavior

| Condition | Behavior |
|---|---|
| Non-TUI mode | Error notification; no process started. |
| Missing interpreter | Error notification; no process started. |
| TypeScript on Node < 22.19 | `UnsupportedRuntimeError`; no process started. |
| Non-zero exit status | Surfaced explicitly in both delivery modes; never silently ignored. |
| Cancelled execution | Explicit cancelled result; reported to the agent only in Run and report mode. |
| Output exceeds 50 KB / 2000 lines | Tail retained; truncation boundary, byte count, and line count shown. |

## Design

See [`.pi/DESIGN.md`](.pi/DESIGN.md) for architecture, trust boundary reasoning, and full scope decisions.
