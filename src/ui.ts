/**
 * Picker, confirmation, editing, and result UI for code block invocation.
 *
 * All four exported functions delegate to ctx.ui.custom() or ctx.ui.editor()
 * and produce no side effects on the agent context.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

/** Clamp a value between min and max inclusive. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Build a single-line content preview for a block (first non-empty line, trimmed). */
function buildPreview(block: FencedBlock): string {
  const firstLine = block.contents
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ?? "(empty)";
}

/**
 * Shared scrollable panel: tracks scroll offset for an array of content lines
 * given an adjustable viewport height.  All mutation is explicit (call scroll*).
 */
class ScrollPanel {
  private scrollOffset = 0;
  private lines: readonly string[];
  private viewportH: number;

  constructor(lines: readonly string[], viewportHeight: number) {
    this.lines = lines;
    this.viewportH = Math.max(1, viewportHeight);
  }

  /**
   * Replace the content lines (e.g. after a width change) and clamp the
   * existing scroll offset so it stays in bounds.
   */
  updateLines(newLines: readonly string[]): void {
    this.lines = newLines;
    this.scrollOffset = clamp(this.scrollOffset, 0, this.maxOffset);
  }

  /**
   * Adjust the viewport height and reclamp the scroll offset.
   * The height is forced to at least 1 so there is always one visible line.
   */
  setViewportHeight(h: number): void {
    this.viewportH = Math.max(1, h);
    this.scrollOffset = clamp(this.scrollOffset, 0, this.maxOffset);
  }

  get viewportHeight(): number {
    return this.viewportH;
  }

  get maxOffset(): number {
    return Math.max(0, this.lines.length - this.viewportH);
  }

  get offset(): number {
    return this.scrollOffset;
  }

  get isAtEnd(): boolean {
    return this.scrollOffset >= this.maxOffset;
  }

  get isAtStart(): boolean {
    return this.scrollOffset === 0;
  }

  scrollBy(delta: number): void {
    this.scrollOffset = clamp(this.scrollOffset + delta, 0, this.maxOffset);
  }

  scrollToStart(): void {
    this.scrollOffset = 0;
  }

  scrollToEnd(): void {
    this.scrollOffset = this.maxOffset;
  }

  /**
   * Render the visible slice into `output`.  Truncates each line to `width`.
   * Appends a scroll-indicator line when content exceeds the viewport.
   */
  render(output: string[], width: number, theme: Theme): void {
    const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + this.viewportH);
    for (const line of visible) {
      output.push(truncateToWidth(line, width));
    }
    if (this.lines.length > this.viewportH) {
      const shown = Math.min(this.scrollOffset + this.viewportH, this.lines.length);
      const indicator = `[${shown}/${this.lines.length} lines — PgUp/PgDn/Home/End to scroll]`;
      output.push(truncateToWidth(theme.fg("dim", indicator), width));
    }
  }
}

// ---------------------------------------------------------------------------
// pickBlock
// ---------------------------------------------------------------------------

const PICKER_VIEWPORT_HEIGHT = 10;

/**
 * Show a searchable picker for the given blocks.
 *
 * - Blocks appear in document order.
 * - Each item label shows the tag; the description is a single-line content preview.
 * - Typing filters items by tag or preview content (case-insensitive substring).
 * - Arrow keys navigate; Enter selects; Esc cancels.
 *
 * Returns the selected block, or `null` on cancel.
 */
export function pickBlock(ctx: ExtensionContext, blocks: FencedBlock[]): Promise<FencedBlock | null> {
  return ctx.ui.custom<FencedBlock | null>((tui, theme, _keybindings, done) => {
    let filter = "";
    let selectedIndex = 0;
    let cachedLines: string[] | undefined;
    let lastRenderWidth = 0;

    function filtered(): FencedBlock[] {
      if (!filter) return blocks;
      const lower = filter.toLowerCase();
      return blocks.filter((b) => b.tag.toLowerCase().includes(lower) || buildPreview(b).toLowerCase().includes(lower));
    }

    function clampSelected(items: FencedBlock[]): void {
      selectedIndex = clamp(selectedIndex, 0, Math.max(0, items.length - 1));
    }

    function invalidate(): void {
      cachedLines = undefined;
      tui.requestRender();
    }

    function handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }

      const items = filtered();

      if (matchesKey(data, Key.enter)) {
        if (items.length === 0) return; // no-op when nothing matches
        const block = items[selectedIndex] ?? null;
        done(block);
        return;
      }

      if (matchesKey(data, Key.up)) {
        selectedIndex = clamp(selectedIndex - 1, 0, Math.max(0, items.length - 1));
        invalidate();
        return;
      }

      if (matchesKey(data, Key.down)) {
        selectedIndex = clamp(selectedIndex + 1, 0, Math.max(0, items.length - 1));
        invalidate();
        return;
      }

      if (matchesKey(data, Key.backspace)) {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          selectedIndex = 0;
          invalidate();
        }
        return;
      }

      // Printable: plain character (charCode >= 32) or Kitty CSI-u sequence.
      // decodeKittyPrintable already rejects Ctrl/Alt modifier combinations.
      const printable = data.length === 1 && data.charCodeAt(0) >= 32 ? data : decodeKittyPrintable(data);
      if (printable !== undefined) {
        filter += printable;
        selectedIndex = 0;
        invalidate();
        return;
      }
    }

    function render(width: number): string[] {
      const w = Math.max(1, width);
      if (w !== lastRenderWidth) {
        cachedLines = undefined;
        lastRenderWidth = w;
      }
      if (cachedLines) return cachedLines;

      const items = filtered();
      clampSelected(items);
      const lines: string[] = [];

      // Header
      const headerLeft = theme.fg("accent", "Select block");
      const filterDisplay = filter ? ` › ${theme.fg("text", filter)}` : theme.fg("dim", " › type to filter");
      lines.push(truncateToWidth(headerLeft + filterDisplay, w));
      lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));

      if (items.length === 0) {
        lines.push(truncateToWidth(theme.fg("warning", "  No matching blocks"), w));
      } else {
        const total = items.length;
        const viewHeight = Math.min(total, PICKER_VIEWPORT_HEIGHT);
        // Center the viewport around selectedIndex, clamped to valid range.
        let viewStart = Math.max(0, selectedIndex - Math.floor((viewHeight - 1) / 2));
        viewStart = Math.min(viewStart, total - viewHeight);
        const viewEnd = viewStart + viewHeight;

        for (let i = viewStart; i < viewEnd; i++) {
          const block = items[i];
          if (!block) continue;
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
          const tag = isSelected ? theme.fg("accent", `[${block.tag}]`) : theme.fg("muted", `[${block.tag}]`);
          const preview = theme.fg("dim", ` ${buildPreview(block)}`);
          const row = prefix + tag + preview;
          lines.push(truncateToWidth(row, w));
        }

        // Compact position indicator when the list is larger than the viewport.
        if (total > PICKER_VIEWPORT_HEIGHT) {
          const indicator = `[${selectedIndex + 1}/${total}]`;
          lines.push(truncateToWidth(theme.fg("dim", indicator), w));
        }
      }

      lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));
      lines.push(truncateToWidth(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), w));

      cachedLines = lines;
      return lines;
    }

    const component: Component & { dispose?(): void } = {
      render,
      handleInput,
      invalidate: () => {
        cachedLines = undefined;
      },
    };

    return component;
  });
}

// ---------------------------------------------------------------------------
// confirmBlock
// ---------------------------------------------------------------------------

const CONFIRM_ACTIONS: Array<{ label: string; value: ConfirmAction }> = [
  { label: "Run locally", value: "run-locally" },
  { label: "Run and report", value: "run-and-report" },
  { label: "Edit before running", value: "edit" },
  { label: "Cancel", value: "cancel" },
];

const CODE_VIEWPORT_HEIGHT = 8;
// Fixed chrome lines around the code panel (header, 3 separators, "Choose action:",
// 4 action rows, hint + optional scroll indicator = 11 worst-case).
const CONFIRM_CHROME_LINES = 11;
const OVERLAY_MARGIN = 2;

/**
 * Show the full code for `block` in a scrollable panel alongside four
 * action choices using a large responsive overlay.
 *
 * - PageUp / PageDown (or Shift+Up / Shift+Down) scroll the code panel.
 * - Home / End jump to the start or end of the code panel.
 * - Arrow keys navigate the action list.
 * - Enter confirms the selected action; Esc cancels (equivalent to "cancel").
 *
 * Returns the selected action, or `null` if the UI was dismissed unexpectedly.
 * Esc always returns `"cancel"` — there is no implicit execution path.
 */
export function confirmBlock(ctx: ExtensionContext, block: FencedBlock): Promise<ConfirmAction> {
  return ctx.ui.custom<ConfirmAction>(
    (tui, theme, _keybindings, done) => {
      const panel = new ScrollPanel([], CODE_VIEWPORT_HEIGHT);
      let lastCodeRenderWidth = 0;
      let lastViewportH = -1;

      let choiceIndex = 0;
      let cachedLines: string[] | undefined;

      function invalidate(): void {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          done("cancel");
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const action = CONFIRM_ACTIONS[choiceIndex];
          done(action?.value ?? "cancel");
          return;
        }

        // Scroll the code panel
        if (matchesKey(data, Key.home)) {
          panel.scrollToStart();
          invalidate();
          return;
        }
        if (matchesKey(data, Key.end)) {
          panel.scrollToEnd();
          invalidate();
          return;
        }
        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.shift("up"))) {
          panel.scrollBy(-panel.viewportHeight);
          invalidate();
          return;
        }
        if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.shift("down"))) {
          panel.scrollBy(panel.viewportHeight);
          invalidate();
          return;
        }

        // Navigate action choices
        if (matchesKey(data, Key.up)) {
          choiceIndex = clamp(choiceIndex - 1, 0, CONFIRM_ACTIONS.length - 1);
          invalidate();
          return;
        }
        if (matchesKey(data, Key.down)) {
          choiceIndex = clamp(choiceIndex + 1, 0, CONFIRM_ACTIONS.length - 1);
          invalidate();
          return;
        }
      }

      function render(width: number): string[] {
        const w = Math.max(1, width);

        // Derive viewport height from current terminal size so short terminals
        // shrink the code panel rather than clipping the action rows.
        const budget = tui.terminal.rows - 2 * OVERLAY_MARGIN;
        const viewportH = clamp(budget - CONFIRM_CHROME_LINES, 1, CODE_VIEWPORT_HEIGHT);
        if (viewportH !== lastViewportH) {
          panel.setViewportHeight(viewportH);
          lastViewportH = viewportH;
          cachedLines = undefined;
        }

        // Re-wrap code at the actual render width when the terminal is resized
        if (w !== lastCodeRenderWidth) {
          panel.updateLines(wrapTextWithAnsi(block.contents, w));
          lastCodeRenderWidth = w;
          cachedLines = undefined;
        }

        if (cachedLines) return cachedLines;

        const lines: string[] = [];

        // Header
        const tagLabel = theme.fg("accent", `[${block.tag}]`);
        lines.push(truncateToWidth(`${tagLabel} ${theme.fg("text", "Review code")}`, w));
        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));

        // Scrollable code panel
        panel.render(lines, w, theme);
        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));

        // Action choices
        lines.push(truncateToWidth(theme.fg("dim", "Choose action:"), w));
        for (let i = 0; i < CONFIRM_ACTIONS.length; i++) {
          const choice = CONFIRM_ACTIONS[i];
          if (!choice) continue;
          const isSelected = i === choiceIndex;
          const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
          const label = isSelected ? theme.fg("accent", choice.label) : theme.fg("text", choice.label);
          lines.push(truncateToWidth(prefix + label, w));
        }

        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));
        lines.push(
          truncateToWidth(
            theme.fg("dim", "↑↓ select action • PgUp/PgDn scroll code • Home/End jump • Enter confirm • Esc cancel"),
            w,
          ),
        );

        cachedLines = lines;
        return lines;
      }

      const component: Component & { dispose?(): void } = {
        render,
        handleInput,
        invalidate: () => {
          cachedLines = undefined;
        },
      };

      return component;
    },
    {
      overlay: true,
      overlayOptions: () => ({
        width: "80%",
        minWidth: 60,
        maxHeight: "100%",
        anchor: "center",
        margin: OVERLAY_MARGIN,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// editBlock
// ---------------------------------------------------------------------------

/**
 * Open a multi-line editor prefilled with the full contents of `block`.
 *
 * Returns an updated block (same tag, edited contents) when the user saves,
 * or `null` when the editor is dismissed without saving.
 *
 * This function does NOT execute or confirm the result — task 5 always calls
 * `confirmBlock` again after `editBlock`.
 */
export async function editBlock(ctx: ExtensionContext, block: FencedBlock): Promise<FencedBlock | null> {
  const result = await ctx.ui.editor(`Edit [${block.tag}] block`, block.contents);
  if (result === undefined) return null;
  return { tag: block.tag, contents: result };
}

// ---------------------------------------------------------------------------
// showExecutionResult
// ---------------------------------------------------------------------------

const RESULT_VIEWPORT_HEIGHT = 12;
// Fixed chrome lines around the output panel (status, 3 separators, "Choose action:",
// 2 action rows, hint + optional scroll indicator + optional truncation line = 11 worst-case).
const RESULT_CHROME_LINES = 11;

const RESULT_ACTIONS: Array<{ label: string; value: ResultAction }> = [
  { label: "Close", value: "close" },
  { label: "Send to agent", value: "send-to-agent" },
];

/**
 * Display execution results in a large responsive scrollable overlay.
 *
 * Shows:
 * - Tag and exit status (zero/nonzero/cancelled).
 * - Combined output (scrollable).
 * - When truncated: the retained/total byte and line counts.
 * - Two post-run actions: Close and Send to agent.
 *
 * Arrow keys navigate the action list; Enter confirms the selected action.
 * Esc is equivalent to Close — no implicit re-execution path.
 * PageUp/PageDown scroll the output panel; Home/End jump to start/end.
 */
export function showExecutionResult(
  ctx: ExtensionContext,
  block: FencedBlock,
  result: ExecuteResult,
): Promise<ResultAction> {
  return ctx.ui.custom<ResultAction>(
    (tui, theme, _keybindings, done) => {
      const panel = new ScrollPanel([], RESULT_VIEWPORT_HEIGHT);
      let lastOutputRenderWidth = 0;
      let lastViewportH = -1;

      let cachedLines: string[] | undefined;

      function invalidate(): void {
        cachedLines = undefined;
        tui.requestRender();
      }

      let resultChoiceIndex = 0;

      function handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          done("close");
          return;
        }

        if (matchesKey(data, Key.enter)) {
          const action = RESULT_ACTIONS[resultChoiceIndex];
          done(action?.value ?? "close");
          return;
        }

        // Navigate action choices
        if (matchesKey(data, Key.up)) {
          resultChoiceIndex = clamp(resultChoiceIndex - 1, 0, RESULT_ACTIONS.length - 1);
          invalidate();
          return;
        }

        if (matchesKey(data, Key.down)) {
          resultChoiceIndex = clamp(resultChoiceIndex + 1, 0, RESULT_ACTIONS.length - 1);
          invalidate();
          return;
        }

        // Scroll the output panel
        if (matchesKey(data, Key.home)) {
          panel.scrollToStart();
          invalidate();
          return;
        }

        if (matchesKey(data, Key.end)) {
          panel.scrollToEnd();
          invalidate();
          return;
        }

        if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.shift("up"))) {
          panel.scrollBy(-panel.viewportHeight);
          invalidate();
          return;
        }

        if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.shift("down"))) {
          panel.scrollBy(panel.viewportHeight);
          invalidate();
          return;
        }
      }

      function buildStatusLine(w: number): string {
        const tagStr = theme.fg("accent", `[${block.tag}]`);

        let statusStr: string;
        if (result.cancelled) {
          statusStr = theme.fg("warning", "cancelled");
        } else if (result.exitCode === 0) {
          statusStr = theme.fg("success", `exit 0`);
        } else {
          statusStr = theme.fg("error", `exit ${result.exitCode}`);
        }

        return truncateToWidth(`${tagStr} ${statusStr}`, w);
      }

      function render(width: number): string[] {
        const w = Math.max(1, width);

        // Derive viewport height from current terminal size; account for worst-case
        // chrome including the optional truncation line.
        const budget = tui.terminal.rows - 2 * OVERLAY_MARGIN;
        const viewportH = clamp(budget - RESULT_CHROME_LINES, 1, RESULT_VIEWPORT_HEIGHT);
        if (viewportH !== lastViewportH) {
          panel.setViewportHeight(viewportH);
          lastViewportH = viewportH;
          cachedLines = undefined;
        }

        // Re-wrap output at the actual render width when the terminal is resized
        if (w !== lastOutputRenderWidth) {
          const wrappedOutput = result.output.length > 0 ? wrapTextWithAnsi(result.output, w) : ["(no output)"];
          panel.updateLines(wrappedOutput);
          lastOutputRenderWidth = w;
          cachedLines = undefined;
        }

        if (cachedLines) return cachedLines;

        const lines: string[] = [];

        lines.push(buildStatusLine(w));
        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));

        // Scrollable output
        panel.render(lines, w, theme);

        // Truncation info when output was cut
        if (result.truncated) {
          lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));
          const retainedLabel = theme.fg("warning", "Output truncated");
          const byteInfo = `retained ${result.outputBytes}/${result.totalBytes} bytes`;
          const lineInfo = `${result.outputLines}/${result.totalLines} lines`;
          lines.push(truncateToWidth(`${retainedLabel} — ${theme.fg("dim", `${byteInfo}, ${lineInfo}`)}`, w));
        }

        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));

        // Action choices
        lines.push(truncateToWidth(theme.fg("dim", "Choose action:"), w));
        for (let i = 0; i < RESULT_ACTIONS.length; i++) {
          const choice = RESULT_ACTIONS[i];
          if (!choice) continue;
          const isSelected = i === resultChoiceIndex;
          const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
          const label = isSelected ? theme.fg("accent", choice.label) : theme.fg("text", choice.label);
          lines.push(truncateToWidth(prefix + label, w));
        }

        lines.push(truncateToWidth(theme.fg("border", "─".repeat(w)), w));
        lines.push(
          truncateToWidth(
            theme.fg("dim", "↑↓ select action • PgUp/PgDn scroll • Home/End jump • Enter confirm • Esc close"),
            w,
          ),
        );

        cachedLines = lines;
        return lines;
      }

      const component: Component & { dispose?(): void } = {
        render,
        handleInput,
        invalidate: () => {
          cachedLines = undefined;
        },
      };

      return component;
    },
    {
      overlay: true,
      overlayOptions: () => ({
        width: "80%",
        minWidth: 60,
        maxHeight: "100%",
        anchor: "center",
        margin: OVERLAY_MARGIN,
      }),
    },
  );
}
