/**
 * Extension entry point for pi-invoker.
 *
 * Registers:
 * - /invoke slash command
 * - ctrl+shift+i keyboard shortcut
 *
 * Both trigger the same orchestration flow: find the latest assistant message,
 * extract fenced code blocks, confirm/edit, execute, show results, and
 * optionally send a structured report.  The slash command waits for Pi to be
 * idle before proceeding; the shortcut returns immediately if Pi is busy.
 */

import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { extractFencedBlocks, type FencedBlock } from "./blocks.js";
import { type ExecuteResult, executeBlock } from "./executor.js";
import { MissingInterpreterError, resolveInterpreter, UnsupportedRuntimeError } from "./interpreters.js";
import { buildReport } from "./report.js";
import { confirmBlock, editBlock, pickBlock, showExecutionResult } from "./ui.js";

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Extracts all text content from the latest assistant message in the current
 * session branch.  Returns null when no assistant message is found.
 */
function extractLatestAssistantText(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch();

  // Traverse backward to find the most recent assistant message entry.
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") continue;
    const { message } = entry;
    // Narrow to assistant role.
    if (!("role" in message) || message.role !== "assistant") continue;

    // Join all text content parts in source order, separated by newlines.
    const textParts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        textParts.push(part.text);
      }
    }
    return textParts.join("\n");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main orchestration flow
// ---------------------------------------------------------------------------

/**
 * Core invocation flow.  Can be called from both the slash command and the
 * keyboard shortcut.
 *
 * Callers are responsible for ensuring Pi is idle before calling this
 * function.  The slash command calls `waitForIdle()` first; the shortcut
 * checks `isIdle()` and returns early if busy.
 *
 * @param ctx - Extension context (mode, sessionManager, ui, cwd, …).
 * @param sendUserMessage - Sends a user message to trigger an LLM turn.
 */
export async function invokeFlow(ctx: ExtensionContext, sendUserMessage: (content: string) => void): Promise<void> {
  // 1. Require TUI mode; explicit error for other modes.
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/invoke is only available in TUI mode.", "error");
    return;
  }

  // 2. Locate the latest assistant message text.
  const assistantText = extractLatestAssistantText(ctx);
  if (assistantText === null) {
    ctx.ui.notify("No assistant message found in the current session.", "warning");
    return;
  }

  // 3. Extract recognized fenced code blocks.
  const blocks = extractFencedBlocks(assistantText);
  if (blocks.length === 0) {
    ctx.ui.notify("No recognized code blocks found in the latest assistant message.", "info");
    return;
  }

  // 4. If there is more than one block, show a picker; if there is exactly one,
  //    use it directly.
  let selectedBlock: FencedBlock;
  if (blocks.length === 1) {
    const first = blocks.at(0);
    if (!first) return; // guarded: length is 1
    selectedBlock = first;
  } else {
    const picked = await pickBlock(ctx, blocks);
    if (picked === null) return; // user dismissed picker
    selectedBlock = picked;
  }

  // 5. Mandatory confirmation loop.
  let block = selectedBlock;
  while (true) {
    const action = await confirmBlock(ctx, block);

    if (action === "cancel") {
      return;
    }

    if (action === "edit") {
      const edited = await editBlock(ctx, block);
      if (edited === null) return; // editor dismissed → return
      block = edited;
      // Loop back to confirmBlock with the edited block.
      continue;
    }

    // action is "run-locally" or "run-and-report"
    const deliverMode = action;

    // 6. Resolve interpreter; surface errors without spawning.
    let descriptor: ReturnType<typeof resolveInterpreter>;
    try {
      descriptor = resolveInterpreter(block.tag);
    } catch (err) {
      if (err instanceof MissingInterpreterError) {
        ctx.ui.notify(`Interpreter not found: ${err.interpreter}`, "error");
      } else if (err instanceof UnsupportedRuntimeError) {
        ctx.ui.notify(`Unsupported runtime: ${err.message}`, "error");
      } else {
        ctx.ui.notify(`Failed to resolve interpreter: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      return;
    }

    // 7. Execute inside ctx.ui.custom with a cancellable BorderedLoader.
    //    On success, done() receives the ExecuteResult.
    //    On unexpected rejection, done() receives the Error so the loader
    //    closes cleanly without hanging.
    const finalBlock = block; // capture for the factory closure
    const result = await ctx.ui.custom<ExecuteResult | Error>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, `Running [${finalBlock.tag}]…`, { cancellable: true });

      // Start execution immediately; close loader when execution settles.
      void executeBlock(descriptor, finalBlock.contents, ctx.cwd, loader.signal).then(
        (execResult) => {
          done(execResult);
        },
        (err: unknown) => {
          done(err instanceof Error ? err : new Error(String(err)));
        },
      );

      return loader;
    });

    // 8. If executeBlock rejected, notify and bail out — no result display or report.
    if (result instanceof Error) {
      ctx.ui.notify(`Execution failed: ${result.message}`, "error");
      return;
    }

    // 9. Show execution result for both delivery modes.
    await showExecutionResult(ctx, finalBlock, result);

    // 10. Deliver structured report in run-and-report mode (including cancelled runs).
    if (deliverMode === "run-and-report") {
      const report = buildReport(finalBlock, result, ctx.cwd);
      sendUserMessage(report);
    }

    // Execution complete — exit the confirmation loop.
    return;
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/** Default export: the Pi extension factory. */
const extension: ExtensionFactory = (pi) => {
  // Register the /invoke slash command.
  // The command handler waits for Pi to be idle before reading the session
  // branch, ensuring the latest assistant message is complete.
  pi.registerCommand("invoke", {
    description: "Invoke the latest fenced code block from the assistant",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await invokeFlow(ctx, (content) => {
        pi.sendUserMessage(content);
      });
    },
  });

  // Register the ctrl+shift+i keyboard shortcut.
  // The shortcut handler does not wait — if Pi is busy it notifies immediately.
  pi.registerShortcut("ctrl+shift+i", {
    description: "Invoke the latest fenced code block from the assistant",
    handler: async (ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for the current response to finish before invoking.", "warning");
        return;
      }
      await invokeFlow(ctx, (content) => {
        pi.sendUserMessage(content);
      });
    },
  });
};

export default extension;
