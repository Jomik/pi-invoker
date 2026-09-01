import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/executor.js";
import { executeBlock } from "../src/executor.js";
import type { ExecutionDescriptor } from "../src/interpreters.js";

// ---------------------------------------------------------------------------
// Shared test helper: a descriptor that runs the current Node binary with no
// extra arguments so stdin is executed as a CommonJS script.
// ---------------------------------------------------------------------------

function nodeDescriptor(): ExecutionDescriptor {
  return { command: process.execPath, args: [] };
}

// ---------------------------------------------------------------------------
// Stdin execution
// ---------------------------------------------------------------------------

describe("executeBlock — stdin execution", () => {
  it("executes code supplied via stdin and captures stdout", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.stdout.write("hello from stdin\\n");`, process.cwd());
    expect(result.output).toContain("hello from stdin");
  });

  it("returns exitCode 0 for a successful script", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.exit(0);`, process.cwd());
    expect(result.exitCode).toBe(0);
  });

  it("cancelled is false for a normal run", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.exit(0);`, process.cwd());
    expect(result.cancelled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined stdout + stderr
// ---------------------------------------------------------------------------

describe("executeBlock — stdout and stderr capture", () => {
  it("captures stdout output", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.stdout.write("out\\n");`, process.cwd());
    expect(result.output).toContain("out");
  });

  it("captures stderr output", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.stderr.write("err\\n");`, process.cwd());
    expect(result.output).toContain("err");
  });

  it("captures both stdout and stderr in the same output string", async () => {
    const result = await executeBlock(
      nodeDescriptor(),
      `process.stdout.write("A\\n"); process.stderr.write("B\\n");`,
      process.cwd(),
    );
    expect(result.output).toContain("A");
    expect(result.output).toContain("B");
  });
});

// ---------------------------------------------------------------------------
// Nonzero exit code
// ---------------------------------------------------------------------------

describe("executeBlock — nonzero exit code", () => {
  it("returns exitCode 7 without throwing", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.exit(7);`, process.cwd());
    expect(result.exitCode).toBe(7);
  });

  it("cancelled is false when process exits nonzero voluntarily", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.exit(7);`, process.cwd());
    expect(result.cancelled).toBe(false);
  });

  it("output before a nonzero exit is retained", async () => {
    const result = await executeBlock(
      nodeDescriptor(),
      `process.stdout.write("before exit\\n"); process.exit(3);`,
      process.cwd(),
    );
    expect(result.output).toContain("before exit");
    expect(result.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Working directory
// ---------------------------------------------------------------------------

describe("executeBlock — cwd propagation", () => {
  let tmpDir: string;
  let realTmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(`${tmpdir()}/pi-executor-test-`);
    // Resolve symlinks (e.g. /tmp → /private/tmp on macOS) so comparisons are stable.
    realTmpDir = realpathSync(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("child process cwd matches the provided directory", async () => {
    const result = await executeBlock(nodeDescriptor(), `process.stdout.write(process.cwd() + "\\n");`, realTmpDir);
    expect(result.output.trim()).toBe(realTmpDir);
  });
});

// ---------------------------------------------------------------------------
// Inherited environment
// ---------------------------------------------------------------------------

describe("executeBlock — environment inheritance", () => {
  it("child process inherits a variable set in process.env", async () => {
    const key = "PI_EXECUTOR_TEST_VAR";
    const value = "inherited-42";
    process.env[key] = value;
    try {
      const result = await executeBlock(
        nodeDescriptor(),
        `process.stdout.write(process.env["${key}"] + "\\n");`,
        process.cwd(),
      );
      expect(result.output.trim()).toBe(value);
    } finally {
      delete process.env[key];
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-abort: signal already aborted before executeBlock is called
// ---------------------------------------------------------------------------

describe("executeBlock — pre-aborted signal", () => {
  it("returns immediately without output", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBlock(
      nodeDescriptor(),
      `process.stdout.write("should not run\\n");`,
      process.cwd(),
      controller.signal,
    );
    expect(result.output).toBe("");
  });

  it("returns cancelled: true", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBlock(nodeDescriptor(), `process.exit(0);`, process.cwd(), controller.signal);
    expect(result.cancelled).toBe(true);
  });

  it("returns exitCode 130", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBlock(nodeDescriptor(), `process.exit(0);`, process.cwd(), controller.signal);
    expect(result.exitCode).toBe(130);
  });

  it("returns truncated: false and zero byte/line counts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBlock(nodeDescriptor(), `process.exit(0);`, process.cwd(), controller.signal);
    expect(result.truncated).toBe(false);
    expect(result.outputBytes).toBe(0);
    expect(result.totalBytes).toBe(0);
    expect(result.outputLines).toBe(0);
    expect(result.totalLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Running abort: signal fired while the process is executing
// ---------------------------------------------------------------------------

describe("executeBlock — abort during execution", () => {
  let midAbortResult: ExecuteResult;

  beforeAll(async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);
    try {
      midAbortResult = await executeBlock(
        nodeDescriptor(),
        `setTimeout(() => {}, 30_000);`,
        process.cwd(),
        controller.signal,
      );
    } finally {
      clearTimeout(abortTimer);
    }
  }, 5000);

  it("returns cancelled: true when signal fires mid-execution", () => {
    expect(midAbortResult.cancelled).toBe(true);
  });

  it("returns a numeric exitCode when signal fires mid-execution", () => {
    expect(typeof midAbortResult.exitCode).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Output bounds — >50 KB input triggers truncation
// ---------------------------------------------------------------------------

describe("executeBlock — output truncation at 50 KB", () => {
  // 600 lines × 100 chars + newline = 60,600 bytes total — exceeds the 50 KB limit.
  const LINE = "x".repeat(100);
  const LINES = 600;
  const code = `
const line = ${JSON.stringify(LINE)};
for (let i = 0; i < ${LINES}; i++) {
  process.stdout.write(line + "\\n");
}
`;

  let result: ExecuteResult;

  beforeAll(async () => {
    result = await executeBlock(nodeDescriptor(), code, process.cwd());
  }, 15000);

  it("totalBytes equals total bytes written by the script", () => {
    // Each line is 101 bytes (100 × 'x' + '\n') × 600 lines.
    expect(result.totalBytes).toBe(101 * LINES);
  });

  it("totalLines equals total lines written by the script", () => {
    expect(result.totalLines).toBe(LINES);
  });

  it("truncated is true", () => {
    expect(result.truncated).toBe(true);
  });

  it("outputBytes is at most 50 KB (51200 bytes)", () => {
    expect(result.outputBytes).toBeLessThanOrEqual(51200);
  });

  it("outputLines is less than totalLines", () => {
    expect(result.outputLines).toBeLessThan(result.totalLines);
  });

  it("output string byte length matches outputBytes", () => {
    expect(Buffer.byteLength(result.output, "utf8")).toBe(result.outputBytes);
  });

  it("outputLines matches newline count in output string", () => {
    const count = (result.output.match(/\n/g) ?? []).length;
    expect(result.outputLines).toBe(count);
  });

  it("exitCode is 0", () => {
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Output bounds — >2000 lines triggers line truncation
// ---------------------------------------------------------------------------

describe("executeBlock — output truncation at 2000 lines", () => {
  // 2500 lines of short content: stays well under 50 KB so only the line
  // limit triggers eviction.
  const TOTAL_LINES = 2500;
  const code = `
for (let i = 0; i < ${TOTAL_LINES}; i++) {
  process.stdout.write("L" + i + "\\n");
}
`;

  let result: ExecuteResult;

  beforeAll(async () => {
    result = await executeBlock(nodeDescriptor(), code, process.cwd());
  }, 15000);

  it("totalLines equals total lines written", () => {
    expect(result.totalLines).toBe(TOTAL_LINES);
  });

  it("truncated is true", () => {
    expect(result.truncated).toBe(true);
  });

  it("outputLines is at most 2000", () => {
    expect(result.outputLines).toBeLessThanOrEqual(2000);
  });

  it("outputLines is less than totalLines", () => {
    expect(result.outputLines).toBeLessThan(result.totalLines);
  });

  it("outputLines matches newline count in retained output", () => {
    const count = (result.output.match(/\n/g) ?? []).length;
    expect(result.outputLines).toBe(count);
  });

  it("output string byte length matches outputBytes", () => {
    expect(Buffer.byteLength(result.output, "utf8")).toBe(result.outputBytes);
  });

  it("exitCode is 0", () => {
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UTF-8 multibyte characters split across stdout writes
// ---------------------------------------------------------------------------

describe("executeBlock — multibyte UTF-8 decoding", () => {
  // Write a 4-byte emoji (\u{1F389} = \xF0\x9F\x8E\x89) in two separate
  // stdout.write calls so that the StringDecoder must buffer the incomplete
  // sequence between calls.
  const code = `
const bytes = Buffer.from([0xF0, 0x9F, 0x8E, 0x89]); // 🎉
process.stdout.write(bytes.slice(0, 2));
process.stdout.write(bytes.slice(2));
process.stdout.write("\\n");
`;

  it("reconstructs the multibyte character intact", async () => {
    const result = await executeBlock(nodeDescriptor(), code, process.cwd());
    expect(result.output).toContain("\u{1F389}");
  });
});

// ---------------------------------------------------------------------------
// Spawn failure + immediate abort: cancelled must be false
// ---------------------------------------------------------------------------

describe("executeBlock — spawn failure with immediate abort", () => {
  it("returns exitCode 1 and cancelled: false when command does not exist and abort fires", async () => {
    const controller = new AbortController();
    // Start the execution, then abort synchronously before the event loop can
    // assign a PID (spawn failure path: pid === undefined).
    const promise = executeBlock(
      { command: "__pi_invoker_definitely_does_not_exist__", args: [] },
      "",
      process.cwd(),
      controller.signal,
    );
    controller.abort();
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.cancelled).toBe(false);
  }, 5000);
});

// ---------------------------------------------------------------------------
// POSIX: child ignoring SIGTERM is force-killed via SIGKILL escalation
// ---------------------------------------------------------------------------

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("executeBlock — SIGKILL escalation (POSIX)", () => {
  it("force-kills a SIGTERM-ignoring child and returns cancelled within timeout", async () => {
    // The child traps SIGTERM (does nothing) and spins indefinitely.
    const code = `
process.on("SIGTERM", () => {});
setTimeout(() => {}, 60_000);
`;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);
    let result: ExecuteResult;
    try {
      result = await executeBlock(nodeDescriptor(), code, process.cwd(), controller.signal);
    } finally {
      clearTimeout(abortTimer);
    }
    expect(result.cancelled).toBe(true);
    expect(typeof result.exitCode).toBe("number");
  }, 5000);
});
