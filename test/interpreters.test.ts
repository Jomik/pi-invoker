import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isRecognizedTag,
  MissingInterpreterError,
  resolveInterpreter,
  TAG_TO_INTERPRETER,
  UnsupportedRuntimeError,
} from "../src/interpreters.js";

// ---------------------------------------------------------------------------
// Helpers — temporary PATH directory with fake executables
// ---------------------------------------------------------------------------

const isWindows = process.platform === "win32";

/** Creates a stub executable in `dir` for `name`. */
function writeFakeExecutable(dir: string, name: string): string {
  const ext = isWindows ? ".bat" : "";
  const filePath = join(dir, name + ext);
  if (isWindows) {
    writeFileSync(filePath, `@echo off\n`);
  } else {
    writeFileSync(filePath, `#!/bin/sh\n`);
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Shared temp directory housing all stub interpreters
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-invoker-test-"));
  for (const name of ["sh", "bash", "zsh", "fish", "python3"]) {
    writeFakeExecutable(tmpDir, name);
  }
  fakePath = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Canonical tag map coverage
// ---------------------------------------------------------------------------

describe("TAG_TO_INTERPRETER canonical map", () => {
  it("maps sh to sh", () => expect(TAG_TO_INTERPRETER.sh).toBe("sh"));
  it("maps shell to sh", () => expect(TAG_TO_INTERPRETER.shell).toBe("sh"));
  it("maps bash to bash", () => expect(TAG_TO_INTERPRETER.bash).toBe("bash"));
  it("maps zsh to zsh", () => expect(TAG_TO_INTERPRETER.zsh).toBe("zsh"));
  it("maps fish to fish", () => expect(TAG_TO_INTERPRETER.fish).toBe("fish"));
  it("maps python to python3", () => expect(TAG_TO_INTERPRETER.python).toBe("python3"));
  it("maps python3 to python3", () => expect(TAG_TO_INTERPRETER.python3).toBe("python3"));
  it("maps py to python3", () => expect(TAG_TO_INTERPRETER.py).toBe("python3"));
  it("maps javascript to node", () => expect(TAG_TO_INTERPRETER.javascript).toBe("node"));
  it("maps js to node", () => expect(TAG_TO_INTERPRETER.js).toBe("node"));
  it("maps node to node", () => expect(TAG_TO_INTERPRETER.node).toBe("node"));
  it("maps typescript to node", () => expect(TAG_TO_INTERPRETER.typescript).toBe("node"));
  it("maps ts to node", () => expect(TAG_TO_INTERPRETER.ts).toBe("node"));
});

// ---------------------------------------------------------------------------
// Prototype-chain safety
// ---------------------------------------------------------------------------

describe("isRecognizedTag prototype-chain safety", () => {
  it.each(["toString", "constructor", "__proto__"])("rejects prototype property %s", (tag) => {
    expect(isRecognizedTag(tag)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JavaScript / Node alias resolution → current Node runtime
// ---------------------------------------------------------------------------

describe("resolveInterpreter — JavaScript and Node aliases", () => {
  it.each(["javascript", "js", "node"] as const)("tag %s resolves to process.execPath", (tag) => {
    const descriptor = resolveInterpreter(tag, { pathEnv: fakePath });
    expect(descriptor.command).toBe(process.execPath);
    expect(descriptor.args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TypeScript alias resolution → current Node runtime + input-type flag
// ---------------------------------------------------------------------------

describe("resolveInterpreter — TypeScript aliases", () => {
  const validVersion = "v22.19.0";

  it.each(["typescript", "ts"] as const)("tag %s resolves to process.execPath", (tag) => {
    const descriptor = resolveInterpreter(tag, { nodeVersion: validVersion, pathEnv: fakePath });
    expect(descriptor.command).toBe(process.execPath);
  });

  it.each(["typescript", "ts"] as const)("tag %s includes --input-type=module-typescript", (tag) => {
    const descriptor = resolveInterpreter(tag, { nodeVersion: validVersion, pathEnv: fakePath });
    expect(descriptor.args).toContain("--input-type=module-typescript");
  });
});

// ---------------------------------------------------------------------------
// TypeScript version boundary checks
// ---------------------------------------------------------------------------

describe("resolveInterpreter — TypeScript Node version enforcement", () => {
  it("22.18.x is rejected", () => {
    expect(() => resolveInterpreter("typescript", { nodeVersion: "v22.18.0", pathEnv: fakePath })).toThrow(
      UnsupportedRuntimeError,
    );
  });

  it("22.18.9 is rejected", () => {
    expect(() => resolveInterpreter("ts", { nodeVersion: "v22.18.9", pathEnv: fakePath })).toThrow(
      UnsupportedRuntimeError,
    );
  });

  it("22.19.0 is accepted", () => {
    expect(() => resolveInterpreter("typescript", { nodeVersion: "v22.19.0", pathEnv: fakePath })).not.toThrow();
  });

  it("22.19.1 is accepted", () => {
    expect(() => resolveInterpreter("ts", { nodeVersion: "v22.19.1", pathEnv: fakePath })).not.toThrow();
  });

  it("23.0.0 is accepted", () => {
    expect(() => resolveInterpreter("typescript", { nodeVersion: "v23.0.0", pathEnv: fakePath })).not.toThrow();
  });

  it("24.0.0 is accepted", () => {
    expect(() => resolveInterpreter("ts", { nodeVersion: "v24.0.0", pathEnv: fakePath })).not.toThrow();
  });

  it("error message includes the runtime version", () => {
    expect(() => resolveInterpreter("typescript", { nodeVersion: "v22.18.0", pathEnv: fakePath })).toThrow("v22.18.0");
  });

  it("error name is UnsupportedRuntimeError", () => {
    try {
      resolveInterpreter("ts", { nodeVersion: "v22.0.0", pathEnv: fakePath });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedRuntimeError);
      expect((err as UnsupportedRuntimeError).name).toBe("UnsupportedRuntimeError");
    }
  });
});

// ---------------------------------------------------------------------------
// Shell alias resolution → PATH-located executable
// ---------------------------------------------------------------------------

describe("resolveInterpreter — shell aliases (fake PATH)", () => {
  it.each(["sh", "shell"] as const)("tag %s resolves to sh on PATH", (tag) => {
    const descriptor = resolveInterpreter(tag, { pathEnv: fakePath });
    expect(descriptor.command).toContain("sh");
    expect(descriptor.args).toEqual([]);
  });

  it("tag bash resolves to bash on PATH", () => {
    const descriptor = resolveInterpreter("bash", { pathEnv: fakePath });
    expect(descriptor.command).toContain("bash");
    expect(descriptor.args).toEqual([]);
  });

  it("tag zsh resolves to zsh on PATH", () => {
    const descriptor = resolveInterpreter("zsh", { pathEnv: fakePath });
    expect(descriptor.command).toContain("zsh");
    expect(descriptor.args).toEqual([]);
  });

  it("tag fish resolves to fish on PATH", () => {
    const descriptor = resolveInterpreter("fish", { pathEnv: fakePath });
    expect(descriptor.command).toContain("fish");
    expect(descriptor.args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Python alias resolution → PATH-located python3
// ---------------------------------------------------------------------------

describe("resolveInterpreter — Python aliases (fake PATH)", () => {
  it.each(["python", "python3", "py"] as const)("tag %s resolves to python3 on PATH", (tag) => {
    const descriptor = resolveInterpreter(tag, { pathEnv: fakePath });
    expect(descriptor.command).toContain("python3");
    expect(descriptor.args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Executable discovered in a temporary PATH directory
// ---------------------------------------------------------------------------

describe("resolveInterpreter — discovers executable in temporary PATH dir", () => {
  let isolatedDir: string;

  beforeAll(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "pi-invoker-isolated-"));
    writeFakeExecutable(isolatedDir, "bash");
  });

  afterAll(() => {
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("finds bash when its directory is on PATH", () => {
    const descriptor = resolveInterpreter("bash", { pathEnv: isolatedDir });
    expect(descriptor.command).toContain("bash");
  });

  it("returns absolute path for the discovered interpreter", () => {
    const descriptor = resolveInterpreter("bash", { pathEnv: isolatedDir });
    // An absolute path begins with / on POSIX or a drive letter on Windows.
    expect(descriptor.command).toMatch(isWindows ? /^[A-Za-z]:[\\/]/ : /^\//);
  });
});

// ---------------------------------------------------------------------------
// findOnPath rejects directories even when they are executable/accessible
// ---------------------------------------------------------------------------

describe("resolveInterpreter — directory named like interpreter is skipped", () => {
  let dirWithFakeDir: string;
  let dirWithRealBash: string;

  beforeAll(() => {
    dirWithFakeDir = mkdtempSync(join(tmpdir(), "pi-invoker-dircheck-a-"));
    dirWithRealBash = mkdtempSync(join(tmpdir(), "pi-invoker-dircheck-b-"));

    // Create a directory named "bash" (± .bat on Windows) in the first PATH entry.
    const ext = isWindows ? ".bat" : "";
    const fakeDir = join(dirWithFakeDir, `bash${ext}`);
    mkdirSync(fakeDir);

    // Create a real executable "bash" in the second PATH entry.
    writeFakeExecutable(dirWithRealBash, "bash");
  });

  afterAll(() => {
    rmSync(dirWithFakeDir, { recursive: true, force: true });
    rmSync(dirWithRealBash, { recursive: true, force: true });
  });

  it("skips a directory named like the interpreter and finds the real executable further on PATH", () => {
    const pathEnv = [dirWithFakeDir, dirWithRealBash].join(delimiter);
    const descriptor = resolveInterpreter("bash", { pathEnv });
    // The resolved command must be the file in the second directory, not the directory in the first.
    expect(descriptor.command).toContain(dirWithRealBash);
    expect(descriptor.args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Missing interpreter — explicit error before code execution
// ---------------------------------------------------------------------------

describe("resolveInterpreter — missing PATH interpreter", () => {
  it("throws MissingInterpreterError when shell is absent", () => {
    expect(() => resolveInterpreter("bash", { pathEnv: "" })).toThrow(MissingInterpreterError);
  });

  it("throws MissingInterpreterError when python3 is absent", () => {
    expect(() => resolveInterpreter("python", { pathEnv: "" })).toThrow(MissingInterpreterError);
  });

  it("error message includes the interpreter name", () => {
    expect(() => resolveInterpreter("bash", { pathEnv: "" })).toThrow("bash");
  });

  it("error name is MissingInterpreterError", () => {
    try {
      resolveInterpreter("zsh", { pathEnv: "" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingInterpreterError);
      expect((err as MissingInterpreterError).name).toBe("MissingInterpreterError");
    }
  });
});

// ---------------------------------------------------------------------------
// JS/TS tags do NOT consult PATH at all
// ---------------------------------------------------------------------------

describe("resolveInterpreter — Node runtime tags ignore PATH", () => {
  it.each(["javascript", "js", "node"] as const)("tag %s resolves even with empty pathEnv", (tag) => {
    expect(() => resolveInterpreter(tag, { pathEnv: "" })).not.toThrow();
  });

  it("typescript resolves with empty pathEnv when version is sufficient", () => {
    expect(() => resolveInterpreter("typescript", { nodeVersion: "v22.19.0", pathEnv: "" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Verify executable actually exists (spot-check the temp dir stub)
// ---------------------------------------------------------------------------

describe("fake executable accessibility", () => {
  it("the fake sh stub is accessible", () => {
    const ext = isWindows ? ".bat" : "";
    const stubPath = join(tmpDir, `sh${ext}`);
    expect(() => accessSync(stubPath, constants.F_OK)).not.toThrow();
  });
});
