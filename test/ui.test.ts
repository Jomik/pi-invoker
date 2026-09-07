/**
 * Tests for src/ui.ts
 *
 * Uses a minimal fake ExtensionContext whose ctx.ui.select/editor/confirm
 * implementations are controllable per test. No ctx.ui.custom is exercised
 * here — these functions must only use the RPC-portable primitives.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import type { ExecuteResult } from "../src/executor.js";
import { confirmBlock, editBlock, pickBlock, showExecutionResult } from "../src/ui.js";

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
