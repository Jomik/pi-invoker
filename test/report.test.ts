/**
 * Tests for src/report.ts
 *
 * Covers:
 * - buildInvocationMessage (Pi custom-message envelope)
 * - invocationResultRenderer (compact + expanded transcript card)
 */

import { describe, expect, it } from "vitest";
import type { FencedBlock } from "../src/blocks.js";
import type { ExecuteResult } from "../src/executor.js";
import {
  buildInvocationMessage,
  INVOCATION_RESULT_CUSTOM_TYPE,
  invocationResultRenderer,
  type ReportData,
} from "../src/report.js";

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

/**
 * Minimal fake Theme — all fg/bg calls pass text through unchanged.
 * cast to any so the structural-typing subset satisfies the Theme parameter.
 */
// biome-ignore lint/suspicious/noExplicitAny: test-only fake
const fakeTheme: any = {
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

const compactOptions = { expanded: false, outputPad: 0 };
const expandedOptions = { expanded: true, outputPad: 0 };

/** Build a minimal CustomMessage<ReportData> for renderer tests. */
function makeMessage(
  details: ReportData | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: test-only
): any {
  return {
    role: "custom",
    customType: INVOCATION_RESULT_CUSTOM_TYPE,
    content: "ignored-in-renderer-tests",
    display: true,
    details,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// buildInvocationMessage — envelope structure
// ---------------------------------------------------------------------------

describe("buildInvocationMessage — envelope structure", () => {
  it("customType matches INVOCATION_RESULT_CUSTOM_TYPE", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    expect(msg.customType).toBe(INVOCATION_RESULT_CUSTOM_TYPE);
  });

  it("display is true", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    expect(msg.display).toBe(true);
  });

  it("details is a ReportData with all required fields", () => {
    const block = makeBlock({ tag: "ts", contents: "console.log(42)" });
    const result = makeResult({ exitCode: 0, outputBytes: 3, totalBytes: 3 });
    const msg = buildInvocationMessage(block, result, "/home/user");
    const d = msg.details;

    expect(d.tag).toBe("ts");
    expect(d.code).toBe("console.log(42)");
    expect(d.cwd).toBe("/home/user");
    expect(typeof d.output).toBe("string");
    expect(typeof d.truncated).toBe("boolean");
    expect(typeof d.outputBytes).toBe("number");
    expect(typeof d.totalBytes).toBe("number");
    expect(typeof d.outputLines).toBe("number");
    expect(typeof d.totalLines).toBe("number");
    expect(typeof d.exitCode).toBe("number");
    expect(typeof d.cancelled).toBe("boolean");
  });

  it("customType string does not appear in model-facing content", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    expect(msg.content).not.toContain(INVOCATION_RESULT_CUSTOM_TYPE);
  });
});

// ---------------------------------------------------------------------------
// buildInvocationMessage — safety instruction ordering
// ---------------------------------------------------------------------------

describe("buildInvocationMessage — safety ordering", () => {
  it("content begins with the safety instruction before any JSON", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    const jsonStart = msg.content.indexOf("{");
    const safetyStart = msg.content.indexOf("A human explicitly confirmed");
    expect(safetyStart).toBeGreaterThanOrEqual(0);
    expect(safetyStart).toBeLessThan(jsonStart);
  });

  it("content mentions untrusted execution data not instructions", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    expect(msg.content).toContain("untrusted execution data");
    expect(msg.content).toContain("not instructions");
  });

  it("content mentions continuing to help", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    expect(msg.content).toContain("continue helping");
  });
});

// ---------------------------------------------------------------------------
// buildInvocationMessage — JSON self-containment
// ---------------------------------------------------------------------------

describe("buildInvocationMessage — JSON self-containment", () => {
  it("content embeds valid JSON", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult(), "/cwd");
    const jsonStart = msg.content.indexOf("{");
    const jsonEnd = msg.content.lastIndexOf("}") + 1;
    expect(() => JSON.parse(msg.content.slice(jsonStart, jsonEnd))).not.toThrow();
  });

  it("JSON payload matches details exactly", () => {
    const block = makeBlock({ tag: "python", contents: "print(1)" });
    const result = makeResult({ output: "1\n", exitCode: 0, outputBytes: 2, totalBytes: 2 });
    const msg = buildInvocationMessage(block, result, "/proj");
    const jsonStart = msg.content.indexOf("{");
    const jsonEnd = msg.content.lastIndexOf("}") + 1;
    const parsed = JSON.parse(msg.content.slice(jsonStart, jsonEnd)) as ReportData;

    expect(parsed.tag).toBe(msg.details.tag);
    expect(parsed.code).toBe(msg.details.code);
    expect(parsed.cwd).toBe(msg.details.cwd);
    expect(parsed.output).toBe(msg.details.output);
    expect(parsed.exitCode).toBe(msg.details.exitCode);
    expect(parsed.cancelled).toBe(msg.details.cancelled);
  });

  it("preserves exact submitted code with backticks and quotes", () => {
    const contents = "echo ```bash\nhello\n``` && echo '\"quoted\"'";
    const block = makeBlock({ contents });
    const msg = buildInvocationMessage(block, makeResult(), "/cwd");
    expect(msg.details.code).toBe(contents);
    // also verify round-trip through the JSON embedded in content
    const jsonStart = msg.content.indexOf("{");
    const jsonEnd = msg.content.lastIndexOf("}") + 1;
    const parsed = JSON.parse(msg.content.slice(jsonStart, jsonEnd)) as ReportData;
    expect(parsed.code).toBe(contents);
  });

  it("deterministic: same inputs produce identical content and details", () => {
    const block = makeBlock({ tag: "sh", contents: "ls -la" });
    const result = makeResult({ output: "total 0\n", exitCode: 0 });
    const first = buildInvocationMessage(block, result, "/tmp");
    const second = buildInvocationMessage(block, result, "/tmp");
    expect(first.content).toBe(second.content);
    expect(JSON.stringify(first.details)).toBe(JSON.stringify(second.details));
  });
});

// ---------------------------------------------------------------------------
// buildInvocationMessage — cancellation / nonzero / truncation
// ---------------------------------------------------------------------------

describe("buildInvocationMessage — edge cases", () => {
  it("cancelled execution has cancelled=true and exitCode=130 in details", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult({ cancelled: true, exitCode: 130 }), "/cwd");
    expect(msg.details.cancelled).toBe(true);
    expect(msg.details.exitCode).toBe(130);
  });

  it("nonzero exit preserves exact exit code", () => {
    const msg = buildInvocationMessage(makeBlock(), makeResult({ exitCode: 2, cancelled: false }), "/cwd");
    expect(msg.details.exitCode).toBe(2);
    expect(msg.details.cancelled).toBe(false);
  });

  it("truncated execution has truncated=true in details and JSON", () => {
    const result = makeResult({ truncated: true, outputBytes: 100, totalBytes: 5000 });
    const msg = buildInvocationMessage(makeBlock(), result, "/cwd");
    expect(msg.details.truncated).toBe(true);
    const jsonStart = msg.content.indexOf("{");
    const jsonEnd = msg.content.lastIndexOf("}") + 1;
    const parsed = JSON.parse(msg.content.slice(jsonStart, jsonEnd)) as ReportData;
    expect(parsed.truncated).toBe(true);
    expect(parsed.outputBytes).toBe(100);
    expect(parsed.totalBytes).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// invocationResultRenderer — compact view
// ---------------------------------------------------------------------------

describe("invocationResultRenderer — compact view", () => {
  it("returns a component (has render method)", () => {
    const data = makeMessage(
      makeResult() && {
        tag: "bash",
        code: "echo hi",
        cwd: "/home",
        output: "hi\n",
        truncated: false,
        outputBytes: 3,
        totalBytes: 3,
        outputLines: 1,
        totalLines: 1,
        exitCode: 0,
        cancelled: false,
      },
    );
    const component = invocationResultRenderer(data, compactOptions, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof component?.render).toBe("function");
  });

  function makeDetails(overrides: Partial<ReportData> = {}): ReportData {
    return {
      tag: "bash",
      code: "echo hi",
      cwd: "/home/user",
      output: "hi\n",
      truncated: false,
      outputBytes: 3,
      totalBytes: 3,
      outputLines: 1,
      totalLines: 1,
      exitCode: 0,
      cancelled: false,
      ...overrides,
    };
  }

  it("compact view includes the language tag", () => {
    const component = invocationResultRenderer(makeMessage(makeDetails({ tag: "python" })), compactOptions, fakeTheme);
    const lines = component?.render(80) ?? [];
    expect(lines.some((l) => l.includes("python"))).toBe(true);
  });

  it("compact view shows exit 0 for successful run", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ exitCode: 0, cancelled: false })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.some((l) => l.includes("exit 0"))).toBe(true);
  });

  it("compact view shows cancelled for a cancelled run", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ cancelled: true, exitCode: 130 })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.some((l) => l.includes("cancelled"))).toBe(true);
  });

  it("compact view shows nonzero exit code", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ exitCode: 2, cancelled: false })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.some((l) => l.includes("exit 2"))).toBe(true);
  });

  it("compact view shows output byte size when not truncated", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ outputBytes: 42, totalBytes: 42, truncated: false })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.some((l) => l.includes("42"))).toBe(true);
  });

  it("compact view shows truncation state when truncated", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ truncated: true, outputBytes: 200, totalBytes: 1000 })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    const combined = lines.join(" ");
    expect(combined).toContain("truncated");
    expect(combined).toContain("200");
    expect(combined).toContain("1000");
  });

  it("compact view does NOT include cwd", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ cwd: "/super/secret/path" })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.join("\n")).not.toContain("/super/secret/path");
  });

  it("compact view does NOT include submitted code", () => {
    const code = "rm -rf /tmp/unique-marker-abc123";
    const component = invocationResultRenderer(makeMessage(makeDetails({ code })), compactOptions, fakeTheme);
    const lines = component?.render(80) ?? [];
    expect(lines.join("\n")).not.toContain("unique-marker-abc123");
  });

  it("compact view does NOT include output text", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ output: "unique-output-xyz789\n" })),
      compactOptions,
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.join("\n")).not.toContain("unique-output-xyz789");
  });

  it("compact view renders at narrow width without throwing", () => {
    const component = invocationResultRenderer(makeMessage(makeDetails()), compactOptions, fakeTheme);
    expect(() => component?.render(20)).not.toThrow();
    expect(() => component?.render(1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// invocationResultRenderer — expanded view
// ---------------------------------------------------------------------------

describe("invocationResultRenderer — expanded view", () => {
  function makeDetails(overrides: Partial<ReportData> = {}): ReportData {
    return {
      tag: "bash",
      code: "echo hi",
      cwd: "/home/user",
      output: "hi\n",
      truncated: false,
      outputBytes: 3,
      totalBytes: 3,
      outputLines: 1,
      totalLines: 1,
      exitCode: 0,
      cancelled: false,
      ...overrides,
    };
  }

  it("returns a component", () => {
    const component = invocationResultRenderer(makeMessage(makeDetails()), expandedOptions, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof component?.render).toBe("function");
  });

  it("expanded view includes the language tag", () => {
    const component = invocationResultRenderer(makeMessage(makeDetails({ tag: "ts" })), expandedOptions, fakeTheme);
    const lines = component?.render(120) ?? [];
    expect(lines.join("\n")).toContain("ts");
  });

  it("expanded view includes cwd", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ cwd: "/expanded/path" })),
      expandedOptions,
      fakeTheme,
    );
    const lines = component?.render(120) ?? [];
    expect(lines.join("\n")).toContain("/expanded/path");
  });

  it("expanded view includes submitted code", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ code: "print('hello world')" })),
      expandedOptions,
      fakeTheme,
    );
    const lines = component?.render(120) ?? [];
    expect(lines.join("\n")).toContain("print('hello world')");
  });

  it("expanded view includes output text", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails({ output: "hello world\n" })),
      expandedOptions,
      fakeTheme,
    );
    const lines = component?.render(120) ?? [];
    expect(lines.join("\n")).toContain("hello world");
  });

  it("expanded view includes all numeric fields", () => {
    const details = makeDetails({
      exitCode: 5,
      outputBytes: 999,
      totalBytes: 2000,
      outputLines: 30,
      totalLines: 80,
    });
    const component = invocationResultRenderer(makeMessage(details), expandedOptions, fakeTheme);
    const text = (component?.render(120) ?? []).join("\n");
    expect(text).toContain("999");
    expect(text).toContain("2000");
    expect(text).toContain("30");
    expect(text).toContain("80");
    expect(text).toContain("5");
  });

  it("expanded view renders at narrow width without throwing", () => {
    const component = invocationResultRenderer(makeMessage(makeDetails()), expandedOptions, fakeTheme);
    expect(() => component?.render(40)).not.toThrow();
    expect(() => component?.render(1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// invocationResultRenderer — outputPad affects card padding
// ---------------------------------------------------------------------------

describe("invocationResultRenderer — outputPad card padding", () => {
  function makeDetails(): ReportData {
    return {
      tag: "bash",
      code: "echo hi",
      cwd: "/home/user",
      output: "hi\n",
      truncated: false,
      outputBytes: 3,
      totalBytes: 3,
      outputLines: 1,
      totalLines: 1,
      exitCode: 0,
      cancelled: false,
    };
  }

  it("outputPad=0 produces no left padding on content lines", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails()),
      { expanded: false, outputPad: 0 },
      fakeTheme,
    );
    const lines = (component?.render(80) ?? []).filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // With paddingX=0, content lines start with the text, not spaces
    expect(lines.some((l) => !l.startsWith(" "))).toBe(true);
  });

  it("outputPad=4 produces left padding on content lines", () => {
    const component = invocationResultRenderer(
      makeMessage(makeDetails()),
      { expanded: false, outputPad: 4 },
      fakeTheme,
    );
    const lines = (component?.render(80) ?? []).filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // With paddingX=4, content lines are indented by 4 spaces
    expect(lines.every((l) => l.startsWith("    "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invocationResultRenderer — safe fallback
// ---------------------------------------------------------------------------

describe("invocationResultRenderer — safe fallback", () => {
  it("returns a component when details is undefined", () => {
    const msg = makeMessage(undefined);
    const component = invocationResultRenderer(msg, compactOptions, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof component?.render).toBe("function");
  });

  it("fallback component renders without throwing", () => {
    const msg = makeMessage(undefined);
    const component = invocationResultRenderer(msg, compactOptions, fakeTheme);
    expect(() => component?.render(80)).not.toThrow();
  });

  it("returns a component when details is null", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate malformed input
    const msg = makeMessage(null as any);
    const component = invocationResultRenderer(msg, compactOptions, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof component?.render).toBe("function");
  });

  it("returns a component when details is malformed (missing fields)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate malformed input
    const msg = makeMessage({ tag: "bash" } as any);
    const component = invocationResultRenderer(msg, compactOptions, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof component?.render).toBe("function");
  });

  it("fallback expanded view also renders without throwing", () => {
    const msg = makeMessage(undefined);
    const component = invocationResultRenderer(msg, expandedOptions, fakeTheme);
    expect(() => component?.render(80)).not.toThrow();
  });
});
