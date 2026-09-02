/**
 * Tests for src/ui.ts
 *
 * Uses a minimal fake ctx/TUI/theme that invokes the component factory
 * synchronously and drives input through handleInput().  The test harness
 * resolves the returned promise only when the component calls done().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import { editInExternalEditor } from "../src/editor.js";
import type { ExecuteResult } from "../src/executor.js";
import {
  type ConfirmAction,
  confirmBlock,
  editBlock,
  pickBlock,
  type ResultAction,
  showExecutionResult,
} from "../src/ui.js";

vi.mock("../src/editor.js", () => ({
  editInExternalEditor: vi.fn(),
}));

const editInExternalEditorMock = vi.mocked(editInExternalEditor);

// ---------------------------------------------------------------------------
// Fake infrastructure shared across all tests
// ---------------------------------------------------------------------------

// Minimal fake TUI — only requestRender() needs to be callable
const fakeTui = {
  mode: "fullscreen",
  children: [],
  fullRedraws: 0,
  addChild: () => {},
  removeChild: () => {},
  clear: () => {},
  getShowHardwareCursor: () => false,
  setShowHardwareCursor: () => {},
  getClearOnShrink: () => false,
  setClearOnShrink: () => {},
  setFocus: () => {},
  showOverlay: () => ({}),
  hideOverlay: () => {},
  hasOverlay: () => false,
  start: () => {},
  stop: () => {},
  renderNow: () => {},
  requestRender: () => {},
  addInputListener: () => () => {},
  removeInputListener: () => {},
  onTerminalColorSchemeChange: () => () => {},
  setTerminalColorSchemeNotifications: () => {},
  queryTerminalBackgroundColor: async () => undefined,
  queryTerminalColorScheme: async () => undefined,
  render: () => [],
  handleInput: () => {},
  invalidate: () => {},
  setLayoutRoot: () => {},
};

// Minimal fake Theme — all fg/bg/styling calls pass text through unchanged
const fakeTheme = {
  fg: (_color: unknown, text: string): string => text,
  bg: (_color: unknown, text: string): string => text,
  bold: (text: string): string => text,
  italic: (text: string): string => text,
  underline: (text: string): string => text,
  inverse: (text: string): string => text,
  strikethrough: (text: string): string => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (s: string) => s,
  getBashModeBorderColor: () => (s: string) => s,
};

// Minimal fake KeybindingsManager
const fakeKeybindings = {};

// The minimal interface our component instances expose
interface TestComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

/**
 * Builds a fake ExtensionCommandContext that:
 * - Captures the component from the first ctx.ui.custom() call
 * - Captures the overlay options from ctx.ui.custom() calls
 * - Supports ctx.ui.editor() with a controllable resolve
 *
 * All type assertions are confined here so the rest of the tests stay clean.
 */
interface MakeDriverOverrides {
  /** Replaces the default stop() counter with a custom implementation (e.g. to observe ordering or throw). */
  stop?(): void;
  /** Replaces the default start() counter with a custom implementation (e.g. to observe ordering or throw). */
  start?(): void;
  /** Replaces the default requestRender() recorder with a custom implementation (e.g. to observe ordering or throw). */
  requestRender?(force?: boolean): void;
}

function makeDriver(overrides?: MakeDriverOverrides) {
  let capturedComponent: TestComponent | undefined;
  let capturedCustomOptions: { overlay?: boolean; overlayOptions?: unknown } | undefined;
  let editorResolve: ((s: string | undefined) => void) | undefined;
  let editorTitle: string | undefined;
  let editorPrefill: string | undefined;
  let editorCalled = false;
  let tuiStopCount = 0;
  let tuiStartCount = 0;
  const tuiRequestRenderCalls: boolean[] = [];

  const tui = {
    ...fakeTui,
    stop:
      overrides?.stop ??
      (() => {
        tuiStopCount++;
      }),
    start:
      overrides?.start ??
      (() => {
        tuiStartCount++;
      }),
    requestRender:
      overrides?.requestRender ??
      ((force?: boolean) => {
        tuiRequestRenderCalls.push(Boolean(force));
      }),
  };

  // biome-ignore lint/suspicious/noExplicitAny: test-only fake
  const ctx: any = {
    ui: {
      custom(factory: unknown, options?: unknown): Promise<unknown> {
        capturedCustomOptions = options as { overlay?: boolean; overlayOptions?: unknown } | undefined;
        return new Promise((resolve) => {
          const f = factory as (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: unknown) => void,
          ) => TestComponent;
          capturedComponent = f(tui, fakeTheme, fakeKeybindings, resolve);
        });
      },
      editor(title: string, prefill?: string): Promise<string | undefined> {
        editorCalled = true;
        editorTitle = title;
        editorPrefill = prefill;
        return new Promise<string | undefined>((resolve) => {
          editorResolve = resolve;
        });
      },
    },
  };

  return {
    ctx: ctx as ExtensionContext,
    /** Whether ctx.ui.editor() was called. */
    get editorCalled(): boolean {
      return editorCalled;
    },
    /** Number of times the driven TUI's stop() was called. */
    get tuiStopCount(): number {
      return tuiStopCount;
    },
    /** Number of times the driven TUI's start() was called. */
    get tuiStartCount(): number {
      return tuiStartCount;
    },
    /** `force` argument recorded for each requestRender() call on the driven TUI. */
    get tuiRequestRenderCalls(): boolean[] {
      return tuiRequestRenderCalls;
    },
    /** Component captured from the most recent ctx.ui.custom() call. */
    get component(): TestComponent {
      if (!capturedComponent) throw new Error("ctx.ui.custom() was not called yet");
      return capturedComponent;
    },
    /** Overlay options captured from the most recent ctx.ui.custom() call. */
    get customOptions(): { overlay?: boolean; overlayOptions?: unknown } | undefined {
      return capturedCustomOptions;
    },
    /** Editor call captured from the most recent ctx.ui.editor() call. */
    get editor(): { title: string; prefill: string | undefined; resolve: (s: string | undefined) => void } {
      if (!editorResolve) throw new Error("ctx.ui.editor() was not called yet");
      return { title: editorTitle ?? "", prefill: editorPrefill, resolve: editorResolve };
    },
  };
}

// ---------------------------------------------------------------------------
// Key sequences understood by matchesKey
// ---------------------------------------------------------------------------
const KEY = {
  escape: "\x1b",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  backspace: "\x7f",
  home: "\x1b[H",
  end: "\x1b[F",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
};

// ---------------------------------------------------------------------------
// pickBlock
// ---------------------------------------------------------------------------

describe("pickBlock", () => {
  const blocks: FencedBlock[] = [
    { tag: "bash", contents: "echo hello" },
    { tag: "python", contents: "print('world')" },
    { tag: "ts", contents: "const x = 1;" },
  ];

  it("renders all blocks in document order with tags and previews", () => {
    const driver = makeDriver();
    void pickBlock(driver.ctx, blocks);

    const lines = driver.component.render(80);
    const joined = lines.join("\n");
    // All three tags present
    expect(joined).toContain("[bash]");
    expect(joined).toContain("[python]");
    expect(joined).toContain("[ts]");
    // Content previews present
    expect(joined).toContain("echo hello");
    expect(joined).toContain("print('world')");
    expect(joined).toContain("const x = 1;");
    // Document order
    const bashIdx = lines.findIndex((l) => l.includes("[bash]"));
    const pyIdx = lines.findIndex((l) => l.includes("[python]"));
    const tsIdx = lines.findIndex((l) => l.includes("[ts]"));
    expect(bashIdx).toBeLessThan(pyIdx);
    expect(pyIdx).toBeLessThan(tsIdx);
  });

  it("filters blocks by typed text, hiding non-matching items", () => {
    const driver = makeDriver();
    void pickBlock(driver.ctx, blocks);

    driver.component.handleInput("p");
    driver.component.handleInput("y");

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("[python]");
    expect(joined).not.toContain("[bash]");
    expect(joined).not.toContain("[ts]");
  });

  it("selects the focused item on Enter", async () => {
    const driver = makeDriver();
    const promise = pickBlock(driver.ctx, blocks);

    driver.component.handleInput(KEY.down); // move to python
    driver.component.handleInput(KEY.enter);

    const selected = await promise;
    expect(selected?.tag).toBe("python");
  });

  it("returns null on Esc (cancel)", async () => {
    const driver = makeDriver();
    const promise = pickBlock(driver.ctx, blocks);
    driver.component.handleInput(KEY.escape);

    const selected = await promise;
    expect(selected).toBeNull();
  });

  it("selects the first remaining item after filtering then Enter", async () => {
    const driver = makeDriver();
    const promise = pickBlock(driver.ctx, blocks);

    driver.component.handleInput("b");
    driver.component.handleInput(KEY.enter);

    const selected = await promise;
    expect(selected?.tag).toBe("bash");
  });

  it("Kitty CSI-u encoded 'p' (\\x1b[112u) filters to Python", () => {
    const driver = makeDriver();
    void pickBlock(driver.ctx, blocks);

    // Kitty keyboard protocol encoding for 'p' (codepoint 112)
    driver.component.handleInput("\x1b[112u");

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("[python]");
    expect(joined).not.toContain("[bash]");
    expect(joined).not.toContain("[ts]");
  });

  it("viewport caps visible rows at 10 and navigation reaches items beyond initial view", async () => {
    // All 13 recognized tags — more than PICKER_VIEWPORT_HEIGHT (10).
    const manyBlocks: FencedBlock[] = [
      { tag: "bash", contents: "a" },
      { tag: "sh", contents: "b" },
      { tag: "shell", contents: "c" },
      { tag: "zsh", contents: "d" },
      { tag: "fish", contents: "e" },
      { tag: "python", contents: "f" },
      { tag: "python3", contents: "g" },
      { tag: "py", contents: "h" },
      { tag: "javascript", contents: "i" },
      { tag: "js", contents: "j" },
      { tag: "node", contents: "k" },
      { tag: "typescript", contents: "l" },
      { tag: "ts", contents: "m" },
    ];
    const driver = makeDriver();
    const promise = pickBlock(driver.ctx, manyBlocks);

    // Initial render: at most 10 item rows visible.
    const initialLines = driver.component.render(80);
    const itemRows = initialLines.filter((l) => /\[\w+\]/.test(l) && !l.includes("Select block"));
    expect(itemRows.length).toBeLessThanOrEqual(10);

    // A compact position indicator should be visible (13 items > 10).
    const hasIndicator = initialLines.some((l) => /\[\d+\/13\]/.test(l));
    expect(hasIndicator).toBe(true);

    // Navigate down to index 12 (last item: "ts"), Enter should select it.
    for (let i = 0; i < 12; i++) driver.component.handleInput(KEY.down);
    driver.component.handleInput(KEY.enter);

    const selected = await promise;
    expect(selected?.tag).toBe("ts");
  });

  it("Enter with zero matches does nothing (does not cancel)", async () => {
    const driver = makeDriver();
    const promise = pickBlock(driver.ctx, blocks);

    // Filter to something that matches nothing.
    driver.component.handleInput("z");
    driver.component.handleInput("z");
    driver.component.handleInput("z");

    // Enter should be a no-op.
    driver.component.handleInput(KEY.enter);

    // Promise should not have settled yet.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Esc properly cancels.
    driver.component.handleInput(KEY.escape);
    expect(await promise).toBeNull();
  });

  it("re-renders at a narrower width without external invalidate — all lines fit", () => {
    const wideBlocks: FencedBlock[] = [
      { tag: "bash", contents: "a".repeat(200) },
      { tag: "python", contents: "b".repeat(200) },
      { tag: "ts", contents: "c".repeat(200) },
    ];
    const driver = makeDriver();
    void pickBlock(driver.ctx, wideBlocks);

    // First render at wide width — populates cache for width 120
    driver.component.render(120);

    // Second render at narrow width — must rebuild without an explicit invalidate
    const narrowWidth = 30;
    const narrowLines = driver.component.render(narrowWidth);
    for (const line of narrowLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(narrowWidth);
    }
  });

  it("backspace removes the last filter character", () => {
    const driver = makeDriver();
    void pickBlock(driver.ctx, blocks);

    driver.component.handleInput("p");
    driver.component.handleInput("y");
    driver.component.handleInput(KEY.backspace); // "py" → "p"

    const joined = driver.component.render(80).join("\n");
    // "p" matches both python and (no others), bash/ts should be hidden
    expect(joined).toContain("[python]");
    // bash doesn't match "p"
    expect(joined).not.toContain("[bash]");
  });

  it("no rendered line exceeds the given width", () => {
    const wideBlocks: FencedBlock[] = [
      { tag: "bash", contents: "a".repeat(200) },
      { tag: "python", contents: "b".repeat(200) },
    ];
    const driver = makeDriver();
    void pickBlock(driver.ctx, wideBlocks);

    const width = 40;
    for (const line of driver.component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

// ---------------------------------------------------------------------------
// confirmBlock
// ---------------------------------------------------------------------------

describe("confirmBlock", () => {
  const block: FencedBlock = { tag: "bash", contents: "echo hello" };

  it("renders inline — does not request overlay mode", () => {
    const driver = makeDriver();
    void confirmBlock(driver.ctx, block);

    expect(driver.customOptions?.overlay).toBeUndefined();
    expect(driver.customOptions?.overlayOptions).toBeUndefined();
  });

  it("Home key scrolls the code panel to the start", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: manyLines });

    // Initialize the panel with a first render
    driver.component.render(80);

    // Scroll down first
    driver.component.handleInput(KEY.pageDown);
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    expect(after).not.toContain("line1\n");

    // Home jumps back to start
    driver.component.handleInput(KEY.home);
    driver.component.invalidate();
    const atStart = driver.component.render(80).join("\n");
    expect(atStart).toContain("line1");
  });

  it("End key scrolls the code panel to the end", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: manyLines });

    // Initially at start
    const before = driver.component.render(80).join("\n");
    expect(before).toContain("line1");

    // End jumps to end of content
    driver.component.handleInput(KEY.end);
    driver.component.invalidate();
    const atEnd = driver.component.render(80).join("\n");
    expect(atEnd).toContain("line20");
  });

  it("renders keyboard hint including Home/End navigation", () => {
    const driver = makeDriver();
    void confirmBlock(driver.ctx, block);

    const joined = driver.component.render(120).join("\n");
    expect(joined).toContain("Home");
    expect(joined).toContain("End");
  });

  it("advertises Shift+Up/Down as the page-scroll hint, not PgUp/PgDn", () => {
    const driver = makeDriver();
    void confirmBlock(driver.ctx, block);

    const joined = driver.component.render(120).join("\n");
    expect(joined).toContain("Shift+");
    expect(joined).not.toContain("PgUp");
    expect(joined).not.toContain("PgDn");
  });

  it("renders the block tag and all four action labels", () => {
    const driver = makeDriver();
    void confirmBlock(driver.ctx, block);

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("[bash]");
    expect(joined).toContain("Run locally");
    expect(joined).toContain("Run and report");
    expect(joined).toContain("Edit before running");
    expect(joined).toContain("Cancel");
  });

  it("renders the full code in the code panel", () => {
    const longBlock: FencedBlock = { tag: "bash", contents: "line1\nline2\nline3" };
    const driver = makeDriver();
    void confirmBlock(driver.ctx, longBlock);

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("line1");
    expect(joined).toContain("line2");
    expect(joined).toContain("line3");
  });

  it.each<[string, string[], ConfirmAction]>([
    ["run-locally (default, no navigation)", [], "run-locally"],
    ["run-and-report (down once)", [KEY.down], "run-and-report"],
    ["edit (down twice)", [KEY.down, KEY.down], "edit"],
    ["cancel (down three times)", [KEY.down, KEY.down, KEY.down], "cancel"],
  ])("returns %s", async (_label, keys, expected) => {
    const driver = makeDriver();
    const promise = confirmBlock(driver.ctx, block);

    for (const k of keys) driver.component.handleInput(k);
    driver.component.handleInput(KEY.enter);

    const action = await promise;
    expect(action).toBe(expected);
  });

  it("Esc returns 'cancel' — no implicit execution", async () => {
    const driver = makeDriver();
    const promise = confirmBlock(driver.ctx, block);
    driver.component.handleInput(KEY.escape);

    const action = await promise;
    expect(action).toBe("cancel");
  });

  it("code panel shows scroll indicator for content longer than viewport", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: manyLines });

    const lines = driver.component.render(80);
    // A scroll indicator should be present
    const hasIndicator = lines.some((l) => l.includes("lines"));
    expect(hasIndicator).toBe(true);
  });

  it("PageDown scrolls the code panel (keyboard usable while code is visible)", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: manyLines });

    const before = driver.component.render(80).join("\n");
    expect(before).toContain("line1");

    driver.component.handleInput(KEY.pageDown);
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    // After scrolling, line1 should have scrolled out of view
    expect(after).not.toContain("line1\n");
    // Later lines are now visible
    expect(after).toContain("line9");
  });

  it("no rendered line exceeds the given width", () => {
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: "a".repeat(200) });

    const width = 40;
    for (const line of driver.component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("Shift+Down advances one fixed 8-line page, Shift+Up returns to the start", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const driver = makeDriver();
    void confirmBlock(driver.ctx, { tag: "bash", contents: manyLines });

    const before = driver.component.render(80).join("\n");
    expect(before).toContain("line1");

    driver.component.handleInput(KEY.shiftDown);
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    expect(after).not.toContain("line1\n");
    expect(after).toContain("line9");

    driver.component.handleInput(KEY.shiftUp);
    driver.component.invalidate();
    const atStart = driver.component.render(80).join("\n");
    expect(atStart).toContain("line1");
  });
});

// ---------------------------------------------------------------------------
// editBlock
// ---------------------------------------------------------------------------

describe("editBlock", () => {
  const block: FencedBlock = { tag: "bash", contents: "echo original" };

  beforeEach(() => {
    editInExternalEditorMock.mockReset();
  });

  it("launches the external editor directly with the block's tag and contents, without calling ctx.ui.editor", async () => {
    editInExternalEditorMock.mockResolvedValue("echo updated");
    const driver = makeDriver();

    await editBlock(driver.ctx, block);

    expect(editInExternalEditorMock).toHaveBeenCalledWith("echo original", "bash");
    expect(driver.editorCalled).toBe(false);
  });

  it("stops the TUI before launching, restarts it, and requests a full render after a successful edit", async () => {
    // Shared ordered event log proving stop() precedes the edit helper, and
    // start()/full render only occur after the helper settles.
    const events: string[] = [];
    editInExternalEditorMock.mockImplementation(async () => {
      events.push("edit-helper");
      return "echo updated";
    });

    const driver = makeDriver({
      stop: () => events.push("stop"),
      start: () => events.push("start"),
      requestRender: (force) => events.push(force ? "render:full" : "render"),
    });

    await editBlock(driver.ctx, block);

    expect(events).toEqual(["stop", "edit-helper", "start", "render:full"]);
  });

  it("returns an updated block preserving the tag when the edit succeeds", async () => {
    editInExternalEditorMock.mockResolvedValue("echo updated");
    const driver = makeDriver();

    const updated = await editBlock(driver.ctx, block);

    expect(updated).toEqual({ tag: "bash", contents: "echo updated" });
  });

  it("returns null and still restarts/renders the TUI when the editor reports no edit", async () => {
    editInExternalEditorMock.mockResolvedValue(null);
    const driver = makeDriver();

    const result = await editBlock(driver.ctx, block);

    expect(result).toBeNull();
    expect(driver.tuiStopCount).toBe(1);
    expect(driver.tuiStartCount).toBe(1);
    expect(driver.tuiRequestRenderCalls).toEqual([true]);
  });

  it("returns null and still restarts/renders the TUI when the helper throws", async () => {
    editInExternalEditorMock.mockRejectedValue(new Error("boom"));
    const driver = makeDriver();

    const result = await editBlock(driver.ctx, block);

    expect(result).toBeNull();
    expect(driver.tuiStopCount).toBe(1);
    expect(driver.tuiStartCount).toBe(1);
    expect(driver.tuiRequestRenderCalls).toEqual([true]);
  });

  it("resolves null without launching the editor when tui.stop() throws", async () => {
    editInExternalEditorMock.mockResolvedValue("echo updated");
    const driver = makeDriver({
      stop: () => {
        throw new Error("stop failed");
      },
    });

    const result = await editBlock(driver.ctx, block);

    expect(result).toBeNull();
    expect(editInExternalEditorMock).not.toHaveBeenCalled();
  });

  it("still resolves with the computed edit outcome when tui.start() throws after a successful edit", async () => {
    editInExternalEditorMock.mockResolvedValue("echo updated");
    const driver = makeDriver({
      start: () => {
        throw new Error("start failed");
      },
    });

    const result = await editBlock(driver.ctx, block);

    expect(result).toEqual({ tag: "bash", contents: "echo updated" });
  });

  it("still resolves with the computed edit outcome when tui.requestRender() throws after a successful edit", async () => {
    editInExternalEditorMock.mockResolvedValue("echo updated");
    const driver = makeDriver({
      requestRender: () => {
        throw new Error("render failed");
      },
    });

    const result = await editBlock(driver.ctx, block);

    expect(result).toEqual({ tag: "bash", contents: "echo updated" });
  });
});

// ---------------------------------------------------------------------------
// showExecutionResult
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    output: "hello",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    outputBytes: 5,
    totalBytes: 5,
    outputLines: 0,
    totalLines: 0,
    ...overrides,
  };
}

describe("showExecutionResult", () => {
  const block: FencedBlock = { tag: "bash", contents: "echo hello" };

  it("renders tag, exit-0 status, and combined output", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: "hello output" }));

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("[bash]");
    expect(joined).toContain("exit 0");
    expect(joined).toContain("hello output");
  });

  it("renders nonzero exit status explicitly", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ exitCode: 2 }));

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("exit 2");
  });

  it("renders explicit 'cancelled' status instead of exit code when cancelled", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ cancelled: true, exitCode: 130 }));

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("cancelled");
  });

  it("renders truncation info with retained/total byte and line counts", () => {
    const driver = makeDriver();
    void showExecutionResult(
      driver.ctx,
      block,
      makeResult({ truncated: true, outputBytes: 1000, totalBytes: 5000, outputLines: 80, totalLines: 400 }),
    );

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("truncated");
    expect(joined).toContain("1000");
    expect(joined).toContain("5000");
    expect(joined).toContain("80");
    expect(joined).toContain("400");
  });

  it("does not render truncation info when output is not truncated", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ truncated: false }));

    expect(driver.component.render(80).join("\n")).not.toContain("truncated");
  });

  it("renders both action labels: Close and Send to agent", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult());

    const joined = driver.component.render(80).join("\n");
    expect(joined).toContain("Close");
    expect(joined).toContain("Send to agent");
  });

  it("Enter with Close selected returns 'close'", async () => {
    const driver = makeDriver();
    const promise = showExecutionResult(driver.ctx, block, makeResult());
    driver.component.handleInput(KEY.enter); // Close is selected by default
    const action = await promise;
    expect(action).toBe<ResultAction>("close");
  });

  it("Enter with Send to agent selected returns 'send-to-agent'", async () => {
    const driver = makeDriver();
    const promise = showExecutionResult(driver.ctx, block, makeResult());
    driver.component.handleInput(KEY.down); // move to Send to agent
    driver.component.handleInput(KEY.enter);
    const action = await promise;
    expect(action).toBe<ResultAction>("send-to-agent");
  });

  it("Esc returns 'close' — not 'send-to-agent'", async () => {
    const driver = makeDriver();
    const promise = showExecutionResult(driver.ctx, block, makeResult());
    driver.component.handleInput(KEY.escape);
    const action = await promise;
    expect(action).toBe<ResultAction>("close");
  });

  it("closes on Enter (resolves the promise) — backward compat", async () => {
    const driver = makeDriver();
    const promise = showExecutionResult(driver.ctx, block, makeResult());
    driver.component.handleInput(KEY.enter);
    await promise;
  });

  it("closes on Esc (resolves the promise) — backward compat", async () => {
    const driver = makeDriver();
    const promise = showExecutionResult(driver.ctx, block, makeResult());
    driver.component.handleInput(KEY.escape);
    await promise;
  });

  it("renders inline — does not request overlay mode", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult());

    expect(driver.customOptions?.overlay).toBeUndefined();
    expect(driver.customOptions?.overlayOptions).toBeUndefined();
  });

  it("Home key scrolls output panel to start", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    // Initialize the panel with a first render
    driver.component.render(80);

    // Scroll down first
    driver.component.handleInput(KEY.pageDown);
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    expect(after).not.toContain("output line 1\n");

    // Home jumps back to start
    driver.component.handleInput(KEY.home);
    driver.component.invalidate();
    const atStart = driver.component.render(80).join("\n");
    expect(atStart).toContain("output line 1");
  });

  it("End key scrolls output panel to end", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    const before = driver.component.render(80).join("\n");
    expect(before).toContain("output line 1");

    driver.component.handleInput(KEY.end);
    driver.component.invalidate();
    const atEnd = driver.component.render(80).join("\n");
    expect(atEnd).toContain("output line 30");
  });

  it("advertises Shift+Up/Down as the page-scroll hint, not PgUp/PgDn", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult());

    const joined = driver.component.render(120).join("\n");
    expect(joined).toContain("Shift+");
    expect(joined).not.toContain("PgUp");
    expect(joined).not.toContain("PgDn");
  });

  it("renders keyboard hint including Home/End navigation", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult());

    const joined = driver.component.render(120).join("\n");
    expect(joined).toContain("Home");
    expect(joined).toContain("End");
  });

  it("PageDown advances a full page (RESULT_VIEWPORT_HEIGHT lines)", () => {
    // 30 lines of output; the fixed viewport is 12 lines.
    // One PageDown should skip exactly 12 lines (RESULT_VIEWPORT_HEIGHT).
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    // Render once to initialise the scroll panel.
    const before = driver.component.render(80).join("\n");
    expect(before).toContain("output line 1");

    driver.component.handleInput(KEY.pageDown);
    driver.component.invalidate();

    const after = driver.component.render(80).join("\n");
    // Line 1 should now be scrolled out of the viewport.
    expect(after).not.toContain("output line 1\n");
    // Line 13 (first line after a 12-line page scroll) should be visible.
    expect(after).toContain("output line 13");
  });

  it("long output is scrollable — scroll indicator appears", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    const lines = driver.component.render(80);
    const hasIndicator = lines.some((l) => l.includes("lines"));
    expect(hasIndicator).toBe(true);
  });

  it("up/down keys navigate action choices, not output scroll", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    driver.component.render(80);

    // Down key navigates action choice, output panel should not scroll
    driver.component.handleInput(KEY.down); // select 'Send to agent'
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    // Output line 1 should still be visible (action list navigation doesn't scroll output)
    expect(after).toContain("output line 1");
  });

  it("no rendered line exceeds the given width — resize regression", () => {
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: "a".repeat(200) }));

    const width = 40;
    for (const line of driver.component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("truncation and status display regression: all fields render at any width", () => {
    const driver = makeDriver();
    void showExecutionResult(
      driver.ctx,
      block,
      makeResult({ truncated: true, outputBytes: 1000, totalBytes: 5000, outputLines: 80, totalLines: 400 }),
    );

    // Ensure truncation info still renders correctly after a resize
    const lines40 = driver.component.render(40);
    const joined40 = lines40.join("\n");
    for (const line of lines40) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    // Key data still present at narrow width
    expect(joined40).toContain("1000");
    expect(joined40).toContain("5000");
  });

  it("Shift+Down advances one fixed 12-line page, Shift+Up returns to the start", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
    const driver = makeDriver();
    void showExecutionResult(driver.ctx, block, makeResult({ output: longOutput, outputLines: 30, totalLines: 30 }));

    const before = driver.component.render(80).join("\n");
    expect(before).toContain("output line 1");

    driver.component.handleInput(KEY.shiftDown);
    driver.component.invalidate();
    const after = driver.component.render(80).join("\n");
    expect(after).not.toContain("output line 1\n");
    expect(after).toContain("output line 13");

    driver.component.handleInput(KEY.shiftUp);
    driver.component.invalidate();
    const atStart = driver.component.render(80).join("\n");
    expect(atStart).toContain("output line 1");
  });
});
