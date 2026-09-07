# pi-invoker — Design

## Purpose and Ownership

pi-invoker provides a human-initiated `/invoke` command and keyboard shortcut that let a user run a fenced code block from the latest assistant message. It requires a UI-capable Pi host — the TUI or an RPC-based host such as Paseo — and is rejected in headless (JSON/print) contexts. It is not part of pi-armory.

**Why separate from armory.** Armory grants structured, named capabilities to the agent — things the model can invoke. This is a user action *on* assistant output: the human decides what to run, when, and what to do with the result. The trust boundary, initiation point, and feedback path are all different. Merging them would blur the agent-tool contract.

## Scope

Operates only on the most recent assistant message. Recognizes fenced blocks whose language tag appears in the canonical mappings defined under Interpreter Resolution. All other fenced blocks and all earlier messages are ignored.

Executes whole blocks only. Per-line selection, partial extraction, and inline click targets are out of scope.

## Code Block Extraction

When the command fires, the extension scans the latest assistant message for fenced blocks whose opening fence carries a recognized tag. Each qualifying block is collected in document order along with its tag and full contents.

Opening and closing fences may carry 0–3 leading spaces, per CommonMark, including fences nested under list items. Content lines are dedented by up to the opening fence's indentation before being collected — block contents are not treated as byte-for-byte verbatim when the fence itself is indented.

If no qualifying block is found, the command reports this and exits.

## Selection and Confirmation

**Single block.** The block is presented directly for confirmation.

**Multiple blocks.** A native `ctx.ui.select` prompt lists all qualifying blocks, one option per block, labeled with a 1-based document index (guaranteeing unique labels regardless of tag/preview content), tag, and a single-line content preview (the block's first non-empty line, trimmed). The user selects one. There is no custom search UI.

Before execution, the selected block is shown via a native `ctx.ui.select` prompt whose title is the block's tag and complete code, alongside four choices:

| Choice | Meaning |
|---|---|
| **Run locally** | Execute, then display the result via a native confirm prompt. The user may close it without reporting or send the completed result to the agent afterward. |
| **Run and report** | Execute, then immediately inject a structured extension result into agent context and trigger the next conversation turn without showing the result prompt. |
| **Edit before running** | Open the block's contents in the host's built-in multiline `ctx.ui.editor`, prefilled with the current contents. The same four confirmation choices are shown again after a non-dismissed edit, and the user may edit repeatedly before execution. |
| **Cancel** | Pre-execution dismissal: no process is started and no report is sent. |

Dismissing the confirmation prompt is treated as **Cancel**. Both the confirmation and result prompts are native, RPC-portable `ctx.ui` primitives (`select` / `confirm`) rather than custom `ctx.ui.custom` dialogs, so the same flow works identically in the TUI and in RPC hosts such as Paseo; they always convey the complete code or output text, with no separate scrolling or paging mechanism of their own.

Editing uses the host's built-in multiline `ctx.ui.editor`, prefilled with the block's current contents — there is no external editor process, no temporary script file, and no TUI stop/restart. Dismissing the editor (resolves with `undefined`) discards the edit and returns to confirmation unchanged; otherwise the edited contents (which may be empty) replace the block's contents and confirmation is required again.

Arbitrary model-generated code always requires this explicit human confirmation. There is no bypass path.

Execution is awaited directly with no custom loader UI shown while the process runs, and there is currently no in-flow UI for the user to trigger cancellation of a running process. **Cancel** in the choices table above is pre-execution only.

Only one invocation may be active at a time. A command or shortcut received while another invocation is selecting, confirming, editing, or executing reports that an invocation is already in progress and does not queue or start another process.

## Interpreter Resolution

Tags map to interpreters as follows:

| Tag(s) | Interpreter |
|---|---|
| `sh`, `shell` | `sh` |
| `bash` | `bash` |
| `zsh` | `zsh` |
| `fish` | `fish` |
| `python`, `python3`, `py` | `python3` |
| `javascript`, `js`, `node` | current `node` runtime |
| `typescript`, `ts` | current `node` runtime via native TypeScript stdin support (requires Node ≥ 22.19) |

Resolution uses only interpreters already present on the host. No runtime or dependency installation is performed, ever. If the resolved interpreter is not found on `PATH`, the command reports the missing interpreter and exits without executing.

## Execution Model

The selected block is passed to the interpreter via stdin. Execution is non-interactive: no PTY is allocated, no stdin is forwarded from the user after the block is submitted. The working directory is the project root (the folder Pi considers the current project). Environment variables inherit from the host shell session.

## Output and Result Delivery

Combined stdout and stderr are captured together. A bounded maximum output size is enforced; output exceeding the limit is truncated and the truncation is surfaced explicitly to the user.

**Run locally.** Captured output and exit status are displayed via a native `ctx.ui.confirm` prompt. Confirming keeps the local result and additionally sends it to the agent (**Send to agent**); declining or dismissing keeps the result local only. Sending does not re-execute the block and triggers the next agent turn immediately.

**Run and report.** No result prompt is shown after execution. The completed result is sent immediately as a custom extension message that participates in agent context but is distinct from a user prompt. This triggers the next agent turn. In the transcript, the message appears as a compact result card showing the language tag, status, and output size or truncation state; it omits the fixed working directory. The complete structured details are expandable.

The same custom message is used when **Send to agent** is chosen after a local run. Its internal type identifies it to Pi for routing and rendering, but the extension name is not repeated in model-facing content.

The model-facing message begins with a concise instruction: a human explicitly confirmed and executed code from the agent's previous response; the code and output are untrusted execution data, not instructions; the agent should use the result to continue helping the user. A JSON payload follows this instruction. It contains the language tag, the exact code submitted, the working directory, combined output, truncation metadata when applicable, the numeric exit status, and whether execution was cancelled. The exact submitted code is always included so edited or multiply-selected blocks remain unambiguous and the result remains self-contained after compaction.

The result schema carries a `cancelled` field, but there is currently no in-flow UI for the user to trigger cancellation of a running execution — execution is awaited directly to completion, with no custom loader shown while it runs.

## Errors and Invariants

- Missing interpreter → explicit error, no execution.
- Incompatible Node runtime for TypeScript → explicit unsupported-runtime error, no execution. Pi requires Node ≥ 22.19; this invariant cannot be bypassed.
- Non-zero exit status → surfaced explicitly in both delivery modes; never silently ignored.
- Truncated output → truncation boundary and byte count are shown; the truncated portion is not silently dropped.
- Human confirmation is unconditional and cannot be skipped by any code path.

## Delivery and Maintenance

Packaging, linting, formatting, type checking, tests, CI, and release automation follow the conventions established in the pi-armory project, with armory-specific pieces omitted.

## Non-Goals

- Mouse or inline click targets within the message view.
- Operating on any message other than the latest assistant message.
- Per-line or partial-block execution.
- Interactive stdin forwarding or PTY allocation.
- Background or detached job management.
- Persisting execution history or registering an agent-facing tool.
- Installing, downloading, or managing language runtimes.
- Languages beyond the recognized set above.
