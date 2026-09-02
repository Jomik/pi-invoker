/**
 * Tests for src/editor.ts
 *
 * node:child_process is mocked so tests control exit codes / spawn errors
 * without launching a real editor; node:fs is real, operating on genuine
 * temp directories so cleanup can be asserted directly.
 */

import * as childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editInExternalEditor, suffixForTag } from "../src/editor.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// A minimal fake ChildProcess: an EventEmitter-like object exposing on/emit.
class FakeChild {
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args);
  }
}

/**
 * Installs a spawn mock that, on the next spawn() call, invokes `onLaunch`
 * with the target file path and then resolves the child with the returned
 * outcome (nonzero/zero close, or a spawn error).
 */
function mockSpawnOnce(onLaunch: (filePath: string) => { exitCode?: number | null; error?: boolean }) {
  const spawnMock = vi.mocked(childProcess.spawn);
  spawnMock.mockImplementationOnce((_command, args) => {
    const argv = args as string[];
    const filePath = argv[argv.length - 1] as string;
    const child = new FakeChild();
    queueMicrotask(() => {
      const { exitCode = 0, error = false } = onLaunch(filePath);
      if (error) {
        child.emit("error", new Error("spawn failed"));
      } else {
        child.emit("close", exitCode);
      }
    });
    // biome-ignore lint/suspicious/noExplicitAny: fake ChildProcess for testing
    return child as any;
  });
  return spawnMock;
}

describe("suffixForTag", () => {
  it.each<[string, string]>([
    ["sh", ".sh"],
    ["shell", ".sh"],
    ["bash", ".sh"],
    ["zsh", ".zsh"],
    ["fish", ".fish"],
    ["py", ".py"],
    ["python", ".py"],
    ["python3", ".py"],
    ["js", ".js"],
    ["javascript", ".js"],
    ["node", ".js"],
    ["ts", ".ts"],
    ["typescript", ".ts"],
    ["ruby", ".txt"],
    ["", ".txt"],
    ["../../etc/passwd", ".txt"],
    ["__proto__", ".txt"],
    ["constructor", ".txt"],
    ["toString", ".txt"],
  ])("maps %s to %s", (tag, suffix) => {
    expect(suffixForTag(tag)).toBe(suffix);
  });
});

describe("editInExternalEditor", () => {
  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;

  beforeEach(() => {
    vi.mocked(childProcess.spawn).mockReset();
    delete process.env.VISUAL;
    process.env.EDITOR = "fake-editor";
  });

  afterEach(() => {
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
  });

  it("writes the exact initial code to a script file with the mapped suffix, and spawns with that path", async () => {
    let capturedContentAtLaunch = "";
    let capturedPath = "";
    mockSpawnOnce((filePath) => {
      capturedPath = filePath;
      capturedContentAtLaunch = readFileSync(filePath, "utf-8");
      return { exitCode: 0 };
    });

    await editInExternalEditor("echo hi", "py");

    expect(capturedPath).toMatch(/script\.py$/);
    expect(capturedPath).toContain("pi-invoker-");
    expect(capturedContentAtLaunch).toBe("echo hi");
  });

  it("resolves VISUAL over EDITOR", async () => {
    process.env.VISUAL = "visual-editor";
    process.env.EDITOR = "editor-editor";
    const spawnMock = mockSpawnOnce(() => ({ exitCode: 0 }));

    await editInExternalEditor("code", "sh");

    expect(spawnMock.mock.calls[0]?.[0]).toBe("visual-editor");
  });

  it("reads edited content on a clean exit, stripping a leading BOM and one trailing newline", async () => {
    mockSpawnOnce((filePath) => {
      writeFileSync(filePath, "\uFEFFedited content\n", "utf-8");
      return { exitCode: 0 };
    });

    const result = await editInExternalEditor("original", "sh");

    expect(result).toBe("edited content");
  });

  it("returns null and does not read edited content on nonzero exit", async () => {
    mockSpawnOnce((filePath) => {
      writeFileSync(filePath, "should not be read", "utf-8");
      return { exitCode: 3 };
    });

    const result = await editInExternalEditor("original", "sh");

    expect(result).toBeNull();
  });

  it("returns null when the editor fails to spawn", async () => {
    mockSpawnOnce(() => ({ error: true }));

    const result = await editInExternalEditor("original", "sh");

    expect(result).toBeNull();
  });

  it("removes the temporary directory after success, failure, and spawn error", async () => {
    for (const outcome of [{ exitCode: 0 }, { exitCode: 1 }, { error: true }] as const) {
      let capturedDir = "";
      mockSpawnOnce((filePath) => {
        capturedDir = dirname(filePath);
        return outcome;
      });

      await editInExternalEditor("original", "sh");

      expect(existsSync(capturedDir)).toBe(false);
    }
  });

  it("quotes the temp file argument and enables shell:true when spawning on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const spawnMock = mockSpawnOnce(() => ({ exitCode: 0 }));

      await editInExternalEditor("original", "sh");

      const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { shell?: boolean }];
      expect(options?.shell).toBe(true);
      const finalArg = args[args.length - 1];
      expect(finalArg).toMatch(/^".*"$/);
      expect(finalArg).toBe(`"${finalArg.slice(1, -1)}"`);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not quote the temp file argument or enable shell:true on non-Windows platforms", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const spawnMock = mockSpawnOnce(() => ({ exitCode: 0 }));

      await editInExternalEditor("original", "sh");

      const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { shell?: boolean }];
      expect(options?.shell).toBe(false);
      const finalArg = args[args.length - 1];
      expect(finalArg.startsWith('"')).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
