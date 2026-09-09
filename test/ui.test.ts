/**
 * Tests for src/ui.ts
 *
 * Uses a minimal fake ExtensionContext whose ctx.ui.select/editor/confirm
 * implementations are controllable per test. pickBlock/confirmBlock/
 * editBlock/showExecutionResult must only use the RPC-portable primitives,
 * so ctx.ui.custom() is not exercised by those tests. runWithLoader is the
 * one exception — it uses ctx.ui.custom() with a BorderedLoader in TUI mode
 * and is covered separately below.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import type { ExecuteResult } from "../src/executor.js";
import { confirmBlock, editBlock, pickBlock, runWithLoader, showExecutionResult } from "../src/ui.js";

// ---------------------------------------------------------------------------
// Fake ExtensionContext
// ---------------------------------------------------------------------------

interface MakeCtxOptions {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

function makeCtx(overrides: MakeCtxOptions = {}) {
  const selectMock = vi.fn(overrides.select ?? (async () => undefined));
  const editorMock = vi.fn(overrides.editor ?? (async () => undefined));
  const confirmMock = vi.fn(overrides.confirm ?? (async () => false));

  // biome-ignore lint/suspicious/noExplicitAny: test-only fake
  const ctx: any = {
    ui: {
      select: selectMock,
      editor: editorMock,
      confirm: confirmMock,
      custom: vi.fn(() => {
        throw new Error("ctx.ui.custom() must not be used");
      }),
    },
  };

  return { ctx: ctx as ExtensionContext, selectMock, editorMock, confirmMock };
}

// ---------------------------------------------------------------------------
// pickBlock
// ---------------------------------------------------------------------------

describe("pickBlock", () => {
  const blocks: FencedBlock[] = [
    { tag: "bash", contents: "echo hello" },
    { tag: "python", contents: "print('world')" },
    { tag: "ts", contents: "const x = 1;" },
  ];

  it("uses ctx.ui.select with all blocks in document order, tags and previews present", async () => {
    const { ctx, selectMock } = makeCtx();
    void pickBlock(ctx, blocks);

    expect(selectMock).toHaveBeenCalledOnce();
    const [, options] = selectMock.mock.calls[0] as [string, string[]];
    expect(options).toHaveLength(3);
    expect(options[0]).toContain("1.");
    expect(options[0]).toContain("[bash]");
    expect(options[0]).toContain("echo hello");
    expect(options[1]).toContain("2.");
    expect(options[1]).toContain("[python]");
    expect(options[1]).toContain("print('world')");
    expect(options[2]).toContain("3.");
    expect(options[2]).toContain("[ts]");
    expect(options[2]).toContain("const x = 1;");
  });

  it("resolves to the block matching the selected label", async () => {
    const { ctx } = makeCtx({
      select: async (_title, options) => options[1],
    });

    const selected = await pickBlock(ctx, blocks);
    expect(selected?.tag).toBe("python");
  });

  it("returns null when ctx.ui.select resolves undefined (cancel/dismiss)", async () => {
    const { ctx } = makeCtx({ select: async () => undefined });

    const selected = await pickBlock(ctx, blocks);
    expect(selected).toBeNull();
  });

  it("keeps labels unique and maps selection to the exact block even with duplicate tags/previews", async () => {
    const dupBlocks: FencedBlock[] = [
      { tag: "bash", contents: "echo same" },
      { tag: "bash", contents: "echo same" },
      { tag: "bash", contents: "echo same" },
    ];
    const { ctx, selectMock } = makeCtx();
    void pickBlock(ctx, dupBlocks);

    const [, options] = selectMock.mock.calls[0] as [string, string[]];
    // All labels must be unique.
    expect(new Set(options).size).toBe(3);

    // Selecting the third label resolves to the exact third block object.
    const { ctx: ctx2 } = makeCtx({ select: async (_title, opts) => opts[2] });
    const selected = await pickBlock(ctx2, dupBlocks);
    expect(selected).toBe(dupBlocks[2]);
  });

  it("does not collide when a natural label already ends in a disambiguation-like suffix", async () => {
    const collidingBlocks: FencedBlock[] = [
      { tag: "bash", contents: "echo same (2)" },
      { tag: "bash", contents: "echo same" },
    ];
    const { ctx, selectMock } = makeCtx();
    void pickBlock(ctx, collidingBlocks);

    const [, options] = selectMock.mock.calls[0] as [string, string[]];
    expect(new Set(options).size).toBe(2);

    // Selecting the first option (whose preview naturally ends in "(2)")
    // must resolve to the first block, not the second.
    const { ctx: ctx2 } = makeCtx({ select: async (_title, opts) => opts[0] });
    const selected = await pickBlock(ctx2, collidingBlocks);
    expect(selected).toBe(collidingBlocks[0]);
  });
});

// ---------------------------------------------------------------------------
// confirmBlock
// ---------------------------------------------------------------------------

describe("confirmBlock", () => {
  const block: FencedBlock = { tag: "bash", contents: "echo hello\necho world" };

  it("shows the complete block contents in the select title", async () => {
    const { ctx, selectMock } = makeCtx();
    void confirmBlock(ctx, block);

    const [title] = selectMock.mock.calls[0] as [string, string[]];
    expect(title).toContain("[bash]");
    expect(title).toContain("echo hello");
    expect(title).toContain("echo world");
  });

  it("offers all four action labels", async () => {
    const { ctx, selectMock } = makeCtx();
    void confirmBlock(ctx, block);

    const [, options] = selectMock.mock.calls[0] as [string, string[]];
    expect(options).toEqual(["Run locally", "Run and report", "Edit before running", "Cancel"]);
  });

  it.each<[string, ConfirmActionExpectation]>([
    ["Run locally", "run-locally"],
    ["Run and report", "run-and-report"],
    ["Edit before running", "edit"],
    ["Cancel", "cancel"],
  ])("maps %s to %s", async (label, expected) => {
    const { ctx } = makeCtx({ select: async () => label });
    const action = await confirmBlock(ctx, block);
    expect(action).toBe(expected);
  });

  it("returns 'cancel' when ctx.ui.select resolves undefined (dismiss)", async () => {
    const { ctx } = makeCtx({ select: async () => undefined });
    const action = await confirmBlock(ctx, block);
    expect(action).toBe("cancel");
  });
});

type ConfirmActionExpectation = "run-locally" | "run-and-report" | "edit" | "cancel";

// ---------------------------------------------------------------------------
// editBlock
// ---------------------------------------------------------------------------

describe("editBlock", () => {
  const block: FencedBlock = { tag: "bash", contents: "echo original" };

  it("calls ctx.ui.editor with a title and the block's contents as prefill", async () => {
    const { ctx, editorMock } = makeCtx({ editor: async () => "echo updated" });
    await editBlock(ctx, block);

    expect(editorMock).toHaveBeenCalledOnce();
    const [title, prefill] = editorMock.mock.calls[0] as [string, string | undefined];
    expect(title).toContain("bash");
    expect(prefill).toBe("echo original");
  });

  it("returns an updated block preserving the tag when the edit succeeds", async () => {
    const { ctx } = makeCtx({ editor: async () => "echo updated" });
    const updated = await editBlock(ctx, block);
    expect(updated).toEqual({ tag: "bash", contents: "echo updated" });
  });

  it("accepts an empty string as a valid edit", async () => {
    const { ctx } = makeCtx({ editor: async () => "" });
    const updated = await editBlock(ctx, block);
    expect(updated).toEqual({ tag: "bash", contents: "" });
  });

  it("returns null only when the editor resolves undefined", async () => {
    const { ctx } = makeCtx({ editor: async () => undefined });
    const updated = await editBlock(ctx, block);
    expect(updated).toBeNull();
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

  it("shows tag and exit-0 status in the title, and complete output in the message", async () => {
    const { ctx, confirmMock } = makeCtx();
    void showExecutionResult(ctx, block, makeResult({ output: "hello output" }));

    const [title, message] = confirmMock.mock.calls[0] as [string, string];
    expect(title).toContain("[bash]");
    expect(title).toContain("exit 0");
    expect(message).toContain("hello output");
  });

  it("shows nonzero exit status explicitly", async () => {
    const { ctx, confirmMock } = makeCtx();
    void showExecutionResult(ctx, block, makeResult({ exitCode: 2 }));

    const [title] = confirmMock.mock.calls[0] as [string, string];
    expect(title).toContain("exit 2");
  });

  it("shows 'cancelled' status instead of exit code when cancelled", async () => {
    const { ctx, confirmMock } = makeCtx();
    void showExecutionResult(ctx, block, makeResult({ cancelled: true, exitCode: 130 }));

    const [title] = confirmMock.mock.calls[0] as [string, string];
    expect(title).toContain("cancelled");
  });

  it("includes retained/total byte and line counts when truncated", async () => {
    const { ctx, confirmMock } = makeCtx();
    void showExecutionResult(
      ctx,
      block,
      makeResult({ truncated: true, outputBytes: 1000, totalBytes: 5000, outputLines: 80, totalLines: 400 }),
    );

    const [, message] = confirmMock.mock.calls[0] as [string, string];
    expect(message).toContain("truncated");
    expect(message).toContain("1000");
    expect(message).toContain("5000");
    expect(message).toContain("80");
    expect(message).toContain("400");
  });

  it("does not mention truncation when output is not truncated", async () => {
    const { ctx, confirmMock } = makeCtx();
    void showExecutionResult(ctx, block, makeResult({ truncated: false }));

    const [, message] = confirmMock.mock.calls[0] as [string, string];
    expect(message).not.toContain("truncated");
  });

  it("returns 'send-to-agent' when ctx.ui.confirm resolves true", async () => {
    const { ctx } = makeCtx({ confirm: async () => true });
    const action = await showExecutionResult(ctx, block, makeResult());
    expect(action).toBe("send-to-agent");
  });

  it("returns 'close' when ctx.ui.confirm resolves false (including dismissal)", async () => {
    const { ctx } = makeCtx({ confirm: async () => false });
    const action = await showExecutionResult(ctx, block, makeResult());
    expect(action).toBe("close");
  });
});

// ---------------------------------------------------------------------------
// runWithLoader
// ---------------------------------------------------------------------------

/**
 * @earendil-works/pi-coding-agent's BorderedLoader is mocked so tests do not
 * depend on its real key-handling/rendering internals. The mock's
 * constructor signature is `(tui, theme, message)`, matching production
 * usage. It exposes `signal` (an AbortSignal) and `handleInput`, plus a
 * test-only `simulateCancelKey()` helper standing in for the loader's
 * configured Escape/Ctrl-C cancel key — invoking `handleInput` aborts
 * `signal` without closing anything itself, mirroring the real component's
 * contract (BorderedLoader/CancellableLoader abort their own signal on
 * cancel; they never close the surrounding custom UI).
 */
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    // biome-ignore lint/complexity/useArrowFunction: must stay constructible for `new BorderedLoader(...)`
    BorderedLoader: vi.fn().mockImplementation(function (tui: unknown, theme: unknown, message: string) {
      const controller = new AbortController();
      // Sentinels standing in for the real BorderedLoader's top/bottom
      // DynamicBorder children, so tests can assert the output Text is
      // inserted immediately before the final (bottom) child.
      const topBorder = { role: "top-border" };
      const bottomBorder = { role: "bottom-border" };
      const children: unknown[] = [topBorder, bottomBorder];
      return {
        tui,
        theme,
        message,
        signal: controller.signal,
        children,
        handleInput: vi.fn(() => controller.abort()),
        dispose: vi.fn(),
        // Test-only stand-in for the loader's real Escape/Ctrl-C key handling.
        simulateCancelKey: () => controller.abort(),
      };
    }),
  };
});

interface FakeLoader {
  message: string;
  signal: AbortSignal;
  children: unknown[];
  handleInput: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  simulateCancelKey: () => void;
}

function makeTuiCtx(): {
  ctx: ExtensionContext;
  customMock: ReturnType<typeof vi.fn>;
  requestRenderMock: ReturnType<typeof vi.fn>;
} {
  // Fake ctx.ui.custom(): invokes the supplied factory with (tui, theme,
  // keybindings, done) and returns a promise resolved by calling `done`,
  // mirroring the real contract where `done(value)` closes the custom UI
  // and resolves the ctx.ui.custom() promise with `value`.
  const requestRenderMock = vi.fn();
  const customMock = vi.fn(
    (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown) => {
      let component: unknown;
      const promise = new Promise((resolve) => {
        component = factory({ requestRender: requestRenderMock }, {}, {}, resolve);
      });
      return Object.assign(promise, { component });
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: test-only fake
  const ctx: any = {
    mode: "tui",
    ui: { custom: customMock },
  };
  return { ctx: ctx as ExtensionContext, customMock, requestRenderMock };
}

/** Retrieve the mounted FakeLoader returned by the most recent ctx.ui.custom() factory call. */
function getLoader(customMock: ReturnType<typeof vi.fn>): FakeLoader {
  const returned = customMock.mock.results[0]?.value as { component: FakeLoader };
  return returned.component;
}

const LOADER_BLOCK: FencedBlock = { tag: "bash", contents: "echo one\necho two" };

describe("runWithLoader", () => {
  it("non-TUI mode calls the operation directly with no ctx.ui.custom dialog", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake
    const ctx: any = {
      mode: "rpc",
      ui: {
        custom: vi.fn(() => {
          throw new Error("ctx.ui.custom() must not be used outside TUI mode");
        }),
      },
    };
    const operation = vi.fn(async (_signal?: AbortSignal) => makeResult());

    const result = await runWithLoader(ctx as ExtensionContext, LOADER_BLOCK, operation);

    expect(operation).toHaveBeenCalledOnce();
    expect(operation.mock.calls[0]?.[0]).toBeUndefined();
    expect(result).toEqual(makeResult());
  });

  it("TUI mode opens ctx.ui.custom and starts the operation with an AbortSignal", async () => {
    const { ctx, customMock } = makeTuiCtx();
    const operation = vi.fn(async (_signal?: AbortSignal) => makeResult());

    await runWithLoader(ctx, LOADER_BLOCK, operation);

    expect(customMock).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    const signal = operation.mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("loader message shows only 'Running [tag]…' and omits the submitted code", async () => {
    const { ctx, customMock } = makeTuiCtx();
    const operation = vi.fn(async (_signal?: AbortSignal) => makeResult());

    await runWithLoader(ctx, LOADER_BLOCK, operation);

    const loader = getLoader(customMock);
    expect(loader.message).toBe("Running [bash]…");
    expect(loader.message).not.toContain("echo one");
    expect(loader.message).not.toContain("echo two");
  });

  it("inserts a Text child into the loader immediately before the final (bottom) child, initialized to '(waiting for output)'", async () => {
    const { ctx, customMock } = makeTuiCtx();
    const operation = vi.fn(async (_signal?: AbortSignal) => makeResult());

    await runWithLoader(ctx, LOADER_BLOCK, operation);

    const loader = getLoader(customMock);
    expect(loader.children).toHaveLength(3);
    const bottomSentinel = loader.children[2] as { role: string };
    expect(bottomSentinel.role).toBe("bottom-border");
    const outputText = loader.children[1] as { render: (width: number) => string[] };
    expect(outputText.render(80).join("\n")).toContain("(waiting for output)");
    // Output Text sits directly before the final bottom border/sentinel.
    expect(loader.children[loader.children.length - 1]).toBe(bottomSentinel);
  });

  it("starts the operation with an onOutput callback that updates the Text content and requests a render", async () => {
    const { ctx, customMock, requestRenderMock } = makeTuiCtx();
    let onOutput: ((retainedOutput: string) => void) | undefined;
    const operation = vi.fn(async (_signal?: AbortSignal, callback?: (retainedOutput: string) => void) => {
      onOutput = callback;
      return makeResult();
    });

    await runWithLoader(ctx, LOADER_BLOCK, operation);

    expect(onOutput).toBeInstanceOf(Function);
    const loader = getLoader(customMock);
    const outputText = loader.children[1] as { render: (width: number) => string[] };

    onOutput?.("hello from the running process");

    expect(outputText.render(80).join("\n")).toContain("hello from the running process");
    expect(requestRenderMock).toHaveBeenCalled();
  });

  it("resolves with the settled ExecuteResult after a normal completion", async () => {
    const { ctx } = makeTuiCtx();
    const settled = makeResult({ output: "done" });
    const operation = vi.fn(async (_signal?: AbortSignal) => settled);

    const result = await runWithLoader(ctx, LOADER_BLOCK, operation);

    expect(result).toBe(settled);
  });

  it(
    "invoking the loader's configured cancel key aborts the operation signal, " +
      "but the custom UI stays pending until the operation settles",
    async () => {
      const { ctx, customMock } = makeTuiCtx();
      let resolveOperation!: (result: ExecuteResult) => void;
      const pending = new Promise<ExecuteResult>((resolve) => {
        resolveOperation = resolve;
      });
      let observedAborted = false;
      const operation = vi.fn((signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => {
          observedAborted = true;
        });
        return pending;
      });

      const runPromise = runWithLoader(ctx, LOADER_BLOCK, operation);
      const loader = getLoader(customMock);

      // Simulate Escape/Ctrl-C: aborts the signal only.
      loader.simulateCancelKey();
      expect(observedAborted).toBe(true);

      // The operation is still pending — the custom UI promise (and thus
      // runWithLoader) must not resolve yet.
      let settled = false;
      runPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      const cancelledResult = makeResult({ cancelled: true, exitCode: 130 });
      resolveOperation(cancelledResult);

      const result = await runPromise;
      expect(result).toBe(cancelledResult);
    },
  );

  it("rethrows the original error when the operation rejects", async () => {
    const { ctx } = makeTuiCtx();
    const failure = new Error("spawn failed");
    const operation = vi.fn(async (_signal?: AbortSignal) => {
      throw failure;
    });

    await expect(runWithLoader(ctx, LOADER_BLOCK, operation)).rejects.toThrow(failure);
  });
});
