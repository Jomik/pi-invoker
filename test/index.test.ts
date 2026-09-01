/**
 * Tests for src/index.ts
 *
 * Uses module mocks for UI functions, executeBlock, and resolveInterpreter so
 * that tests run without a real TUI or spawned processes.
 */

import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import type { ExecuteResult } from "../src/executor.js";
import { type ExecutionDescriptor, MissingInterpreterError, UnsupportedRuntimeError } from "../src/interpreters.js";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

// Mock the executor so we never spawn a real process.
vi.mock("../src/executor.js", () => ({
  executeBlock: vi.fn(),
}));

// Mock resolveInterpreter to return a fake descriptor by default.
vi.mock("../src/interpreters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/interpreters.js")>();
  return {
    ...actual, // preserves MissingInterpreterError and UnsupportedRuntimeError
    resolveInterpreter: vi.fn(),
  };
});

// Mock the four UI functions so tests can control their return values.
vi.mock("../src/ui.js", () => ({
  pickBlock: vi.fn(),
  confirmBlock: vi.fn(),
  editBlock: vi.fn(),
  showExecutionResult: vi.fn(),
}));

// Mock BorderedLoader from the Pi package.
const hoisted = vi.hoisted(() => {
  class FakeBorderedLoader {
    private controller = new AbortController();

    get signal(): AbortSignal {
      return this.controller.signal;
    }

    render(_width: number): string[] {
      return [];
    }

    handleInput(_data: string): void {}

    invalidate(): void {}

    dispose(): void {}
  }

  return { FakeBorderedLoader };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    BorderedLoader: hoisted.FakeBorderedLoader,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { executeBlock } from "../src/executor.js";
import extension, { invokeFlow } from "../src/index.js";
import { resolveInterpreter } from "../src/interpreters.js";
import { confirmBlock, editBlock, pickBlock, showExecutionResult } from "../src/ui.js";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const mockExecuteBlock = executeBlock as unknown as MockInstance;
const mockResolveInterpreter = resolveInterpreter as unknown as MockInstance;
const mockPickBlock = pickBlock as unknown as MockInstance;
const mockConfirmBlock = confirmBlock as unknown as MockInstance;
const mockEditBlock = editBlock as unknown as MockInstance;
const mockShowExecutionResult = showExecutionResult as unknown as MockInstance;

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

const FAKE_DESCRIPTOR: ExecutionDescriptor = { command: "/usr/bin/bash", args: [] };

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    output: "hello\n",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    outputBytes: 6,
    totalBytes: 6,
    outputLines: 1,
    totalLines: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ExtensionCommandContext builder
// ---------------------------------------------------------------------------

interface NotifyCall {
  message: string;
  type?: string;
}

interface FakeCtxOptions {
  mode?: string;
  branch?: unknown[];
  isIdleNow?: boolean;
}

function makeFakeCtx(options: FakeCtxOptions = {}) {
  const mode = options.mode ?? "tui";
  // Default: one assistant message entry with a bash block
  const branch = options.branch ?? [
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2024-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is a bash block:\n```bash\necho hello\n```" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1000,
      },
    },
  ];

  const notifyCalls: NotifyCall[] = [];
  let customDoneRef: ((result: unknown) => void) | null = null;

  // biome-ignore lint/suspicious/noExplicitAny: test-only fake
  const ctx: any = {
    mode,
    cwd: "/project",
    sessionManager: {
      getBranch: () => branch,
    },
    isIdle: () => options.isIdleNow ?? true,
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    ui: {
      notify: vi.fn((message: string, type?: string) => {
        notifyCalls.push({ message, type });
      }),
      custom: vi.fn(async (factory: unknown) => {
        // Invoke the factory, capturing done; resolve when done is called.
        return new Promise((resolve) => {
          const f = factory as (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: unknown) => void,
          ) => unknown;
          customDoneRef = resolve;
          f(
            {}, // fake tui
            { fg: (_: unknown, s: string) => s }, // fake theme
            {}, // fake keybindings
            resolve,
          );
        });
      }),
    },
  };

  return {
    ctx,
    notifyCalls,
    get customDone(): (result: unknown) => void {
      if (!customDoneRef) throw new Error("ui.custom was not called yet");
      return customDoneRef;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake sendUserMessage
// ---------------------------------------------------------------------------

function makeSendUserMessage() {
  const calls: string[] = [];
  const sendUserMessage = vi.fn((content: string) => {
    calls.push(content);
  });
  return { sendUserMessage, calls };
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveInterpreter.mockReturnValue(FAKE_DESCRIPTOR);
  mockShowExecutionResult.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. Non-TUI mode guard
// ---------------------------------------------------------------------------

describe("invokeFlow — non-TUI mode", () => {
  it("notifies with an error and returns without extracting blocks", async () => {
    const { ctx, notifyCalls } = makeFakeCtx({ mode: "rpc" });
    const { sendUserMessage } = makeSendUserMessage();

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.type).toBe("error");
    // No execution attempted
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("exits early in non-TUI mode without attempting execution", async () => {
    const { ctx } = makeFakeCtx({ mode: "json" });
    const { sendUserMessage } = makeSendUserMessage();

    await invokeFlow(ctx, sendUserMessage);

    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Factory registration and handler behavior
// ---------------------------------------------------------------------------

describe("extension factory — registration", () => {
  function makeFactoryPi() {
    const registeredCommands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
    const registeredShortcuts: Record<string, { handler: (ctx: unknown) => Promise<void> }> = {};
    const sentMessages: string[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test-only fake
    const pi: any = {
      registerCommand: vi.fn((name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        registeredCommands[name] = opts;
      }),
      registerShortcut: vi.fn((key: string, opts: { handler: (ctx: unknown) => Promise<void> }) => {
        registeredShortcuts[key] = opts;
      }),
      sendUserMessage: vi.fn((content: string) => {
        sentMessages.push(content);
      }),
    };

    return { pi, registeredCommands, registeredShortcuts, sentMessages };
  }

  it("/invoke command is registered", () => {
    const { pi, registeredCommands } = makeFactoryPi();
    extension(pi);
    expect(registeredCommands.invoke).toBeDefined();
  });

  it("ctrl+shift+i shortcut is registered", () => {
    const { pi, registeredShortcuts } = makeFactoryPi();
    extension(pi);
    expect(registeredShortcuts["ctrl+shift+i"]).toBeDefined();
  });

  it("command handler calls waitForIdle before reading the session branch", async () => {
    const { pi, registeredCommands } = makeFactoryPi();
    extension(pi);

    const getBranchSpy = vi.fn().mockReturnValue([]);
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake
    const ctx: any = {
      mode: "tui",
      cwd: "/project",
      sessionManager: { getBranch: getBranchSpy },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      isIdle: () => true,
      ui: { notify: vi.fn(), custom: vi.fn() },
    };

    const invokeHandler = registeredCommands.invoke;
    if (!invokeHandler) throw new Error("invoke command not registered");
    await invokeHandler.handler("", ctx);

    const waitOrder = ctx.waitForIdle.mock.invocationCallOrder[0];
    const getBranchOrder = getBranchSpy.mock.invocationCallOrder[0];
    expect(waitOrder).toBeDefined();
    expect(getBranchOrder).toBeDefined();
    expect(waitOrder).toBeLessThan(getBranchOrder);
  });

  it("shortcut handler notifies when agent is busy and does not execute", async () => {
    const { pi, registeredShortcuts } = makeFactoryPi();
    extension(pi);

    const notifyCalls: { message: string; type?: string }[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake
    const busyCtx: any = {
      mode: "tui",
      cwd: "/project",
      sessionManager: { getBranch: vi.fn().mockReturnValue([]) },
      isIdle: () => false, // busy
      ui: {
        notify: vi.fn((message: string, type?: string) => {
          notifyCalls.push({ message, type });
        }),
        custom: vi.fn(),
      },
    };

    const shortcutEntry = registeredShortcuts["ctrl+shift+i"];
    if (!shortcutEntry) throw new Error("ctrl+shift+i shortcut not registered");
    await shortcutEntry.handler(busyCtx);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.type).toBe("warning");
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. No assistant message
// ---------------------------------------------------------------------------

describe("invokeFlow — no assistant message", () => {
  it("notifies with a warning when there is no assistant message", async () => {
    const { ctx, notifyCalls } = makeFakeCtx({ branch: [] });
    const { sendUserMessage } = makeSendUserMessage();

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.type).toBe("warning");
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("ignores non-message entries in the branch", async () => {
    const branch = [
      {
        type: "model_change",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01",
        provider: "anthropic",
        modelId: "claude-3",
      },
    ];
    const { ctx, notifyCalls } = makeFakeCtx({ branch });
    const { sendUserMessage } = makeSendUserMessage();

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls[0]?.type).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// 4. Latest assistant message only / text joining
// ---------------------------------------------------------------------------

describe("invokeFlow — latest assistant message", () => {
  it("uses the LAST assistant message (not an earlier one)", async () => {
    // Earlier message has a ts block; later message has a bash block.
    const branch = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```ts\nconst x = 1;\n```" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2024-01-01T00:00:01Z",
        message: {
          role: "user",
          content: "run it",
          timestamp: 2000,
        },
      },
      {
        type: "message",
        id: "e3",
        parentId: "e2",
        timestamp: "2024-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```bash\necho hello\n```" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3000,
        },
      },
    ];

    const { ctx } = makeFakeCtx({ branch });
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    // confirmBlock is called only once; check the block's tag comes from the last message.
    expect(mockConfirmBlock).toHaveBeenCalledOnce();
    expect(mockConfirmBlock.mock.calls[0]?.[1]?.tag).toBe("bash");
  });

  it("joins multiple text parts from the latest assistant message in source order", async () => {
    // Two text parts; blocks appear in the second part.
    const branch = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First part has no blocks.\n" },
            { type: "text", text: "```python\nprint(42)\n```" },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
    ];

    const { ctx } = makeFakeCtx({ branch });
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    expect(mockConfirmBlock).toHaveBeenCalledOnce();
    expect(mockConfirmBlock.mock.calls[0]?.[1]?.tag).toBe("python");
  });

  it("skips thinking content parts (only text parts are joined)", async () => {
    const branch = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "```bash\necho should-be-ignored\n```" },
            { type: "text", text: "```bash\necho hello\n```" },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
    ];

    const { ctx } = makeFakeCtx({ branch });
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    // Only one block (from the text part, not the thinking part)
    expect(mockConfirmBlock).toHaveBeenCalledOnce();
    expect(mockConfirmBlock.mock.calls[0]?.[1]?.contents).toBe("echo hello");
  });
});

// ---------------------------------------------------------------------------
// 5. No recognized blocks
// ---------------------------------------------------------------------------

describe("invokeFlow — no recognized blocks", () => {
  it("notifies with info message and does not execute", async () => {
    const branch = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No code blocks here." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
    ];

    const { ctx, notifyCalls } = makeFakeCtx({ branch });
    const { sendUserMessage } = makeSendUserMessage();

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.type).toBe("info");
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Single block — picker is skipped
// ---------------------------------------------------------------------------

describe("invokeFlow — single block", () => {
  it("skips pickBlock and goes directly to confirmBlock", async () => {
    const { ctx } = makeFakeCtx(); // default branch has one bash block
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    expect(mockPickBlock).not.toHaveBeenCalled();
    expect(mockConfirmBlock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple blocks — picker is shown
// ---------------------------------------------------------------------------

describe("invokeFlow — multiple blocks", () => {
  function makeBranchWithMultipleBlocks() {
    return [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "```bash\necho first\n```\n```python\nprint('second')\n```",
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
      },
    ];
  }

  it("calls pickBlock when there are multiple blocks", async () => {
    const { ctx } = makeFakeCtx({ branch: makeBranchWithMultipleBlocks() });
    const { sendUserMessage } = makeSendUserMessage();

    mockPickBlock.mockResolvedValue(null); // user dismisses picker

    await invokeFlow(ctx, sendUserMessage);

    expect(mockPickBlock).toHaveBeenCalledOnce();
    expect(mockConfirmBlock).not.toHaveBeenCalled();
  });

  it("dismissal of picker (null) returns without confirmation", async () => {
    const { ctx } = makeFakeCtx({ branch: makeBranchWithMultipleBlocks() });
    const { sendUserMessage } = makeSendUserMessage();

    mockPickBlock.mockResolvedValue(null);

    await invokeFlow(ctx, sendUserMessage);

    expect(mockConfirmBlock).not.toHaveBeenCalled();
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("selected block from picker is passed to confirmBlock", async () => {
    const { ctx } = makeFakeCtx({ branch: makeBranchWithMultipleBlocks() });
    const { sendUserMessage } = makeSendUserMessage();

    const selectedBlock: FencedBlock = { tag: "python", contents: "print('second')" };
    mockPickBlock.mockResolvedValue(selectedBlock);
    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    expect(mockConfirmBlock.mock.calls[0]?.[1]).toEqual(selectedBlock);
  });
});

// ---------------------------------------------------------------------------
// 8. Confirmation choices
// ---------------------------------------------------------------------------

describe("invokeFlow — confirmation loop", () => {
  it("cancel returns without execution", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("Esc (cancel) returns without execution", async () => {
    // confirmBlock already returns "cancel" for Esc; same test as above.
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("cancel");

    await invokeFlow(ctx, sendUserMessage);

    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("edit then dismissal returns without execution", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("edit");
    mockEditBlock.mockResolvedValue(null); // editor dismissed

    await invokeFlow(ctx, sendUserMessage);

    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("edit reconfirmation: confirmBlock called TWICE before execution", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    const editedBlock: FencedBlock = { tag: "bash", contents: "echo edited" };
    // First confirm → edit; second confirm → run-locally
    mockConfirmBlock.mockResolvedValueOnce("edit").mockResolvedValueOnce("run-locally");
    mockEditBlock.mockResolvedValue(editedBlock);
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    expect(mockConfirmBlock).toHaveBeenCalledTimes(2);
    expect(mockExecuteBlock).toHaveBeenCalledOnce();
  });

  it("second confirmBlock receives the edited block contents", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    const editedBlock: FencedBlock = { tag: "bash", contents: "echo edited" };
    mockConfirmBlock.mockResolvedValueOnce("edit").mockResolvedValueOnce("run-locally");
    mockEditBlock.mockResolvedValue(editedBlock);
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    // Second call to confirmBlock should receive the edited block
    expect(mockConfirmBlock.mock.calls[1]?.[1]).toEqual(editedBlock);
  });

  it("executeBlock is called with the submitted code (after edit)", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    const editedBlock: FencedBlock = { tag: "bash", contents: "echo edited" };
    mockConfirmBlock.mockResolvedValueOnce("edit").mockResolvedValueOnce("run-locally");
    mockEditBlock.mockResolvedValue(editedBlock);
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    // The code arg to executeBlock should be the edited contents
    expect(mockExecuteBlock.mock.calls[0]?.[1]).toBe("echo edited");
  });
});

// ---------------------------------------------------------------------------
// 9. Interpreter resolution errors
// ---------------------------------------------------------------------------

describe("invokeFlow — interpreter errors", () => {
  it("MissingInterpreterError shows error notification and does not execute", async () => {
    const { ctx, notifyCalls } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockResolveInterpreter.mockImplementation(() => {
      throw new MissingInterpreterError("bash");
    });

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls.some((n) => n.type === "error")).toBe(true);
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("UnsupportedRuntimeError shows error notification and does not execute", async () => {
    const { ctx, notifyCalls } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockResolveInterpreter.mockImplementation(() => {
      throw new UnsupportedRuntimeError("v20.0.0");
    });

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls.some((n) => n.type === "error")).toBe(true);
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });

  it("generic resolution error shows error notification and does not execute", async () => {
    const { ctx, notifyCalls } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockResolveInterpreter.mockImplementation(() => {
      throw new Error("unexpected resolution failure");
    });

    await invokeFlow(ctx, sendUserMessage);

    expect(notifyCalls.some((n) => n.type === "error")).toBe(true);
    expect(mockExecuteBlock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Loader signal passed to executeBlock
// ---------------------------------------------------------------------------

describe("invokeFlow — loader signal", () => {
  it("executeBlock receives an AbortSignal from the loader", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    const signalArg = mockExecuteBlock.mock.calls[0]?.[3];
    expect(signalArg).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// 10b. executeBlock rejection — loader closes, error notified, no report sent
// ---------------------------------------------------------------------------

describe("invokeFlow — executeBlock rejection", () => {
  it("notifies execution failure when executeBlock rejects and does not send a report", async () => {
    const { ctx, notifyCalls } = makeFakeCtx();
    const { sendUserMessage, calls } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-and-report");
    mockExecuteBlock.mockRejectedValue(new Error("spawn failed"));

    await invokeFlow(ctx, sendUserMessage);

    // An error notification should have been shown
    expect(notifyCalls.some((n) => n.type === "error")).toBe(true);
    // showExecutionResult and sendUserMessage must NOT be called
    expect(mockShowExecutionResult).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Cancellation: run-locally vs run-and-report
// ---------------------------------------------------------------------------

describe("invokeFlow — cancellation", () => {
  it("run-locally: cancelled result does NOT call sendUserMessage", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage, calls } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult({ cancelled: true, exitCode: 130 }));

    await invokeFlow(ctx, sendUserMessage);

    expect(calls).toHaveLength(0);
  });

  it("run-and-report: cancelled result DOES call sendUserMessage with structured JSON report", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage, calls } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-and-report");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult({ cancelled: true, exitCode: 130 }));

    await invokeFlow(ctx, sendUserMessage);

    expect(calls).toHaveLength(1);
    const msg = calls.at(0);
    if (!msg) throw new Error("expected a message");
    const jsonStart = msg.indexOf("{");
    const jsonEnd = msg.lastIndexOf("}") + 1;
    const data = JSON.parse(msg.slice(jsonStart, jsonEnd)) as {
      cancelled: boolean;
      exitCode: number;
      cwd: string;
      code: string;
    };
    expect(data.cancelled).toBe(true);
    expect(data.exitCode).toBe(130);
    expect(typeof data.cwd).toBe("string");
    expect(data.cwd).toBe("/project");
    expect(typeof data.code).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 12. Delivery modes
// ---------------------------------------------------------------------------

describe("invokeFlow — delivery modes", () => {
  it("run-locally: showExecutionResult is called", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    expect(mockShowExecutionResult).toHaveBeenCalledOnce();
  });

  it("run-locally: sendUserMessage is NEVER called", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage, calls } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-locally");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    expect(calls).toHaveLength(0);
  });

  it("run-and-report: showExecutionResult is called before sendUserMessage", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage } = makeSendUserMessage();

    const orderLog: string[] = [];
    mockShowExecutionResult.mockImplementation(async () => {
      orderLog.push("show");
    });
    sendUserMessage.mockImplementation(() => {
      orderLog.push("send");
    });

    mockConfirmBlock.mockResolvedValue("run-and-report");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    expect(orderLog).toEqual(["show", "send"]);
  });

  it("run-and-report: sendUserMessage is called with a report containing the tag", async () => {
    const { ctx } = makeFakeCtx();
    const { sendUserMessage, calls } = makeSendUserMessage();

    mockConfirmBlock.mockResolvedValue("run-and-report");
    mockExecuteBlock.mockResolvedValue(makeExecuteResult());

    await invokeFlow(ctx, sendUserMessage);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("bash");
  });
});
