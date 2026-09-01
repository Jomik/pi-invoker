/**
 * Tests for src/report.ts
 *
 * Pure tests for buildReport — no Pi dependencies required.
 */

import { describe, expect, it } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import type { ExecuteResult } from "../src/executor.js";
import { buildReport, type ReportData } from "../src/report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<FencedBlock> = {}): FencedBlock {
  return { tag: "bash", contents: "echo hello", ...overrides };
}

function makeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
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

/** Parse the JSON payload embedded in a buildReport string. */
function parseReport(reportText: string): ReportData {
  // The report starts with a header line, then the JSON payload.
  const jsonStart = reportText.indexOf("{");
  const jsonEnd = reportText.lastIndexOf("}") + 1;
  return JSON.parse(reportText.slice(jsonStart, jsonEnd)) as ReportData;
}

// ---------------------------------------------------------------------------
// Deterministic structure
// ---------------------------------------------------------------------------

describe("buildReport — structure", () => {
  it("returns a string", () => {
    const report = buildReport(makeBlock(), makeResult(), "/cwd");
    expect(typeof report).toBe("string");
  });

  it("report contains valid JSON", () => {
    const report = buildReport(makeBlock(), makeResult(), "/cwd");
    expect(() => parseReport(report)).not.toThrow();
  });

  it("parsed report includes all required fields", () => {
    const block = makeBlock({ tag: "ts", contents: "console.log(1)" });
    const result = makeResult({ output: "1\n", exitCode: 0, outputBytes: 2, totalBytes: 2 });
    const data = parseReport(buildReport(block, result, "/project"));

    expect(data.tag).toBe("ts");
    expect(data.code).toBe("console.log(1)");
    expect(data.cwd).toBe("/project");
    expect(data.output).toBe("1\n");
    expect(data.exitCode).toBe(0);
    expect(data.cancelled).toBe(false);
    expect(data.truncated).toBe(false);
    expect(typeof data.outputBytes).toBe("number");
    expect(typeof data.totalBytes).toBe("number");
    expect(typeof data.outputLines).toBe("number");
    expect(typeof data.totalLines).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Successful execution
// ---------------------------------------------------------------------------

describe("buildReport — success", () => {
  it("sets exitCode 0 and cancelled false", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ exitCode: 0, cancelled: false }), "/cwd"));
    expect(data.exitCode).toBe(0);
    expect(data.cancelled).toBe(false);
  });

  it("captures the output text", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ output: "result line\n" }), "/cwd"));
    expect(data.output).toBe("result line\n");
  });

  it("does not include a truncation notice when not truncated", () => {
    const report = buildReport(makeBlock(), makeResult({ truncated: false }), "/cwd");
    expect(report).not.toContain("Output truncated:");
  });
});

// ---------------------------------------------------------------------------
// Nonzero exit code
// ---------------------------------------------------------------------------

describe("buildReport — nonzero exit", () => {
  it("records the exact exit code", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ exitCode: 2, cancelled: false }), "/cwd"));
    expect(data.exitCode).toBe(2);
  });

  it("cancelled is false for a normal nonzero exit", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ exitCode: 1, cancelled: false }), "/cwd"));
    expect(data.cancelled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancelled execution
// ---------------------------------------------------------------------------

describe("buildReport — cancelled", () => {
  it("sets cancelled true", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ cancelled: true, exitCode: 130 }), "/cwd"));
    expect(data.cancelled).toBe(true);
  });

  it("records exitCode 130 for an OS-cancelled execution", () => {
    const data = parseReport(buildReport(makeBlock(), makeResult({ cancelled: true, exitCode: 130 }), "/cwd"));
    expect(data.exitCode).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// Truncated output
// ---------------------------------------------------------------------------

describe("buildReport — truncated", () => {
  it("sets truncated true in the JSON payload", () => {
    const result = makeResult({
      truncated: true,
      output: "tail...",
      outputBytes: 200,
      totalBytes: 1000,
      outputLines: 10,
      totalLines: 100,
    });
    const data = parseReport(buildReport(makeBlock(), result, "/cwd"));
    expect(data.truncated).toBe(true);
  });

  it("includes a plain-text truncation notice after the JSON payload", () => {
    const result = makeResult({
      truncated: true,
      outputBytes: 200,
      totalBytes: 1000,
      outputLines: 10,
      totalLines: 100,
    });
    const report = buildReport(makeBlock(), result, "/cwd");
    expect(report).toContain("truncated");
    expect(report).toContain("200");
    expect(report).toContain("1000");
    expect(report).toContain("10");
    expect(report).toContain("100");
  });

  it("retained and total byte/line counts are correct in JSON payload", () => {
    const result = makeResult({
      truncated: true,
      outputBytes: 512,
      totalBytes: 2048,
      outputLines: 40,
      totalLines: 200,
    });
    const data = parseReport(buildReport(makeBlock(), result, "/cwd"));
    expect(data.outputBytes).toBe(512);
    expect(data.totalBytes).toBe(2048);
    expect(data.outputLines).toBe(40);
    expect(data.totalLines).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Special characters — backticks and Markdown-unsafe content
// ---------------------------------------------------------------------------

describe("buildReport — code/output with backticks and special chars", () => {
  it("safely serializes code containing triple backticks", () => {
    const block = makeBlock({ contents: "echo ```bash\nhello\n```" });
    const data = parseReport(buildReport(block, makeResult(), "/cwd"));
    expect(data.code).toBe("echo ```bash\nhello\n```");
  });

  it("safely serializes output containing triple backticks", () => {
    const result = makeResult({ output: "```shell\nresult\n```" });
    const data = parseReport(buildReport(makeBlock(), result, "/cwd"));
    expect(data.output).toBe("```shell\nresult\n```");
  });

  it("safely serializes code containing newlines and quotes", () => {
    const block = makeBlock({ contents: `line1\n"quoted"\nline3` });
    const data = parseReport(buildReport(block, makeResult(), "/cwd"));
    expect(data.code).toBe(`line1\n"quoted"\nline3`);
  });

  it("round-trips arbitrary unicode in code and output", () => {
    const block = makeBlock({ contents: "echo '🚀'" });
    const result = makeResult({ output: "🚀\n" });
    const data = parseReport(buildReport(block, result, "/cwd"));
    expect(data.code).toBe("echo '🚀'");
    expect(data.output).toBe("🚀\n");
  });

  it("deterministic output: same inputs produce identical strings", () => {
    const block = makeBlock({ tag: "python", contents: "print(42)" });
    const result = makeResult({ output: "42\n", exitCode: 0 });
    const first = buildReport(block, result, "/home/user");
    const second = buildReport(block, result, "/home/user");
    expect(first).toBe(second);
  });
});
