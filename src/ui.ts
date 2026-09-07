/**
 * Picker, confirmation, editing, and result UI for code block invocation.
 *
 * Uses only RPC-portable primitives from ctx.ui (select / editor / confirm)
 * so this extension works identically in TUI and RPC modes. No ctx.ui.custom
 * dialogs and no external-editor process are used here.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FencedBlock } from "./blocks.js";
import type { ExecuteResult } from "./executor.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Actions returned by confirmBlock. */
export type ConfirmAction = "run-locally" | "run-and-report" | "edit" | "cancel";

/** Actions returned by showExecutionResult for a local-run result. */
export type ResultAction = "close" | "send-to-agent";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a single-line content preview for a block (first non-empty line, trimmed). */
function buildPreview(block: FencedBlock): string {
  const firstLine = block.contents
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ?? "(empty)";
}

/**
 * Build a per-block picker label, prefixed with its 1-based document index.
 * The index prefix guarantees uniqueness regardless of tag/preview content,
 * so selection can be mapped back to the exact block deterministically.
 */
function buildLabel(block: FencedBlock, index: number): string {
  return `${index + 1}. [${block.tag}] ${buildPreview(block)}`;
}

// ---------------------------------------------------------------------------
// pickBlock
// ---------------------------------------------------------------------------

/**
 * Show a selector for the given blocks via ctx.ui.select().
 *
 * - Blocks appear in document order.
 * - Each option shows its 1-based document index, tag, and a single-line
 *   content preview; the index prefix guarantees unique labels, so
 *   selection maps back to the exact block deterministically.
 *
 * Returns the selected block, or `null` on cancel/dismissal.
 */
export async function pickBlock(ctx: ExtensionContext, blocks: FencedBlock[]): Promise<FencedBlock | null> {
  const labels = blocks.map((block, index) => buildLabel(block, index));
  const choice = await ctx.ui.select("Select block", labels);
  if (choice === undefined) return null;
  const index = labels.indexOf(choice);
  if (index === -1) return null;
  return blocks[index] ?? null;
}

// ---------------------------------------------------------------------------
// confirmBlock
// ---------------------------------------------------------------------------

const CONFIRM_OPTIONS: Array<{ label: string; value: ConfirmAction }> = [
  { label: "Run locally", value: "run-locally" },
  { label: "Run and report", value: "run-and-report" },
  { label: "Edit before running", value: "edit" },
  { label: "Cancel", value: "cancel" },
];

/**
 * Show the full contents of `block` via ctx.ui.select() alongside four
 * action choices, so arbitrary model-generated code remains reviewable
 * before execution.
 *
 * Returns the selected action, or `"cancel"` on dismissal — there is no
 * implicit execution path.
 */
export async function confirmBlock(ctx: ExtensionContext, block: FencedBlock): Promise<ConfirmAction> {
  const title = `[${block.tag}]\n${block.contents}`;
  const labels = CONFIRM_OPTIONS.map((o) => o.label);
  const choice = await ctx.ui.select(title, labels);
  if (choice === undefined) return "cancel";
  const option = CONFIRM_OPTIONS.find((o) => o.label === choice);
  return option?.value ?? "cancel";
}

// ---------------------------------------------------------------------------
// editBlock
// ---------------------------------------------------------------------------

/**
 * Edit the full contents of `block` via ctx.ui.editor(), prefilled with the
 * current contents.
 *
 * Returns an updated block (same tag, edited contents) — an empty string is
 * a valid edit. Returns `null` only when the editor is dismissed
 * (ctx.ui.editor() resolves with `undefined`).
 *
 * This function does NOT execute or confirm the result — invokeFlow always
 * calls `confirmBlock` again after `editBlock`.
 */
export async function editBlock(ctx: ExtensionContext, block: FencedBlock): Promise<FencedBlock | null> {
  const edited = await ctx.ui.editor(`Edit [${block.tag}]`, block.contents);
  if (edited === undefined) return null;
  return { tag: block.tag, contents: edited };
}

// ---------------------------------------------------------------------------
// showExecutionResult
// ---------------------------------------------------------------------------

/**
 * Display execution results via ctx.ui.confirm(), showing:
 * - Tag and exit status (zero/nonzero/cancelled).
 * - Complete combined output.
 * - When truncated: the retained/total byte and line counts.
 *
 * Returns `"send-to-agent"` when the user confirms, `"close"` otherwise
 * (including dismissal).
 */
export async function showExecutionResult(
  ctx: ExtensionContext,
  block: FencedBlock,
  result: ExecuteResult,
): Promise<ResultAction> {
  let statusStr: string;
  if (result.cancelled) {
    statusStr = "cancelled";
  } else if (result.exitCode === 0) {
    statusStr = "exit 0";
  } else {
    statusStr = `exit ${result.exitCode}`;
  }

  const title = `[${block.tag}] ${statusStr}`;

  const outputSection = result.output.length > 0 ? result.output : "(no output)";
  const truncationSection = result.truncated
    ? `\n\nOutput truncated — retained ${result.outputBytes}/${result.totalBytes} bytes, ${result.outputLines}/${result.totalLines} lines`
    : "";

  const message = `${outputSection}${truncationSection}\n\nSend to agent?`;

  const confirmed = await ctx.ui.confirm(title, message);
  return confirmed ? "send-to-agent" : "close";
}
