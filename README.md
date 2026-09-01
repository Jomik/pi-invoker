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

Only one invocation can be active at a time. A second command or shortcut issued while an invocation is already in progress is rejected with a notification; it is not queued.

### Block selection

If the latest assistant message contains a single recognized block it is presented immediately for confirmation. If it contains multiple blocks a searchable picker lists all of them (tag + content preview); select one to proceed.

### Confirmation

The full block is shown in a large scrollable overlay alongside four choices:

| Choice | Meaning |
|---|---|
| **Run locally** | Execute; result shown in a scrollable overlay. Can be closed or sent to the agent. |
| **Run and report** | Execute; send a structured result to the agent immediately, triggering the next agent turn. |
| **Edit before running** | Open the block in Pi's multi-line editor; confirmation is required again after saving. |
| **Cancel** | Dismiss without starting any process. |

The code panel supports **PageUp / PageDown** (or Shift+Up / Shift+Down) to scroll and **Home / End** to jump to the start or end. Arrow keys navigate the action list.

Confirmation is unconditional — there is no bypass path.

### Editing

**Edit before running** opens Pi's multi-line editor (which honours any external-editor Pi has configured) prefilled with the block contents. On save, confirmation restarts with the edited code. The edit-and-reconfirm cycle may repeat any number of times before execution actually starts. The extension does not directly invoke or manage an external editor; that is Pi's responsibility.

### Result display

**Run locally** shows the result in a large scrollable overlay. The overlay displays the language tag, `exit 0` / `exit N` or `cancelled`, and combined output. When output was tail-bounded the retained and total byte and line counts are shown. On shorter terminals, the viewport shrinks to reduce clipping, though action list visibility is not guaranteed at arbitrarily small heights. The overlay supports the same scroll keys as the confirmation panel (**PageUp / PageDown**, **Home / End**).

Two actions are available after a local run:

| Action | Meaning |
|---|---|
| **Close** | Dismiss the overlay. The agent is not notified. |
| **Send to agent** | Deliver the captured result as a custom message, triggering the next agent turn. Uses the result already captured — the block is not re-executed. |

**Run and report** skips the result overlay entirely and delivers the result to the agent immediately after execution completes.

### Result delivery

When a result is delivered to the agent (either via **Send to agent** or **Run and report**), it is sent as a **custom extension message** — not a plain user prompt. The message is displayed in the conversation transcript as a compact card showing:

- Language tag
- `exit 0` / `exit N` (on success or non-zero exit) or `cancelled`
- Output byte size, or `truncated (retained/total bytes)` when tail-bounded

The card omits the working directory, code, and output. Expanded details are available by expanding the card in the transcript.

The model-facing payload includes:
- Safety framing: explicit notice that a human confirmed and executed the code, and that the output is untrusted data rather than instructions.
- `tag` — language tag of the executed block.
- `code` — exact submitted code (as edited by the user, if applicable).
- `cwd` — working directory at time of execution.
- `output` — combined stdout + stderr (tail-retained).
- `truncated` — boolean; `true` when earlier output was evicted to stay within limits.
- `outputBytes` — retained UTF-8 byte length of `output`.
- `totalBytes` — total UTF-8 byte length of all received output.
- `outputLines` — newline count in retained `output`.
- `totalLines` — total newline count across all received output.
- `exitCode` — numeric process exit status.
- `cancelled` — whether execution was terminated via cancellation. Cancellation is reported as `cancelled` in the compact card rather than as an exit status.

Cancelled executions are reported in both **Send to agent** and **Run and report** modes.

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
| Non-zero exit status | Surfaced explicitly; never silently ignored. |
| Cancelled execution | Explicit cancelled result; reported when delivered to the agent in either mode. |
| Output exceeds 50 KB / 2000 lines | Tail retained; truncation boundary, byte count, and line count shown. |
| Concurrent invocation | Rejected with a notification; the second trigger is not queued. |

## Design

See [`.pi/DESIGN.md`](.pi/DESIGN.md) for architecture, trust boundary reasoning, and full scope decisions.
