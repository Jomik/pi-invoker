# pi-invoker — Design

## Purpose and Ownership

pi-invoker provides a human-initiated `/invoke` command and keyboard shortcut that let a user run a fenced code block from the latest assistant message. It is not part of pi-armory.

**Why separate from armory.** Armory grants structured, named capabilities to the agent — things the model can invoke. This is a user action *on* assistant output: the human decides what to run, when, and what to do with the result. The trust boundary, initiation point, and feedback path are all different. Merging them would blur the agent-tool contract.

## Scope

Operates only on the most recent assistant message. Recognizes fenced blocks whose language tag appears in the canonical mappings defined under Interpreter Resolution. All other fenced blocks and all earlier messages are ignored.

Executes whole blocks only. Per-line selection, partial extraction, and inline click targets are out of scope.

## Code Block Extraction

When the command fires, the extension scans the latest assistant message for fenced blocks whose opening fence carries a recognized tag. Each qualifying block is collected in document order along with its tag and full contents.

If no qualifying block is found, the command reports this and exits.

## Selection and Confirmation

**Single block.** The block is presented directly for confirmation.

**Multiple blocks.** A searchable picker lists all qualifying blocks, showing tag and a content preview. The user selects one.

Before execution, the selected block is displayed in full alongside four choices:

| Choice | Meaning |
|---|---|
| **Run locally** | Execute; display result in the extension UI only. |
| **Run and report** | Execute; inject a structured report into agent context and trigger the next conversation turn. |
| **Edit before running** | Open the block contents in an inline editor; confirmation is required again after editing. |
| **Cancel** | Pre-execution dismissal: no process is started and no report is sent. |

Arbitrary model-generated code always requires this explicit human confirmation. There is no bypass path.

**Cancel** in this table is pre-execution only. Cancelling a process that is already running is distinct: it surfaces an explicit cancelled result and, in **Run and report** mode only, that result is reported to the agent.

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

**Run locally.** Captured output and exit status are displayed in the extension UI. Nothing enters the agent context.

**Run and report.** A structured report is injected into the conversation as a new user message. The report contains: the language tag, the code block as submitted, the working directory, combined output (or a truncation notice), and the numeric exit status. This triggers the next agent turn immediately.

Cancellation of a running execution is supported. A cancelled execution surfaces an explicit cancelled result in the extension UI. In **Run and report** mode, the cancellation is also reported to the agent as a structured result; in **Run locally** mode it is not.

## Errors and Invariants

- Missing interpreter → explicit error, no execution.
- Incompatible Node runtime for TypeScript → explicit unsupported-runtime error, no execution. Pi requires Node ≥ 22.19; this invariant cannot be bypassed.
- Non-zero exit status → surfaced explicitly in both delivery modes; never silently ignored.
- Cancelled running execution → explicit cancelled result surfaced in both delivery modes; reported to the agent only in Run and report mode.
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
