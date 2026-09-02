import { describe, expect, it } from "vitest";
import { extractFencedBlocks } from "../src/blocks.js";

// ---------------------------------------------------------------------------
// All recognized language aliases
// ---------------------------------------------------------------------------

describe("recognized shell tags", () => {
  it.each(["sh", "shell"])("extracts tag %s", (tag) => {
    const md = `\`\`\`${tag}\necho hello\n\`\`\``;
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe(tag);
    expect(blocks[0]?.contents).toBe("echo hello");
  });

  it.each(["bash", "zsh", "fish"])("extracts tag %s", (tag) => {
    const md = `\`\`\`${tag}\nexec $tag\n\`\`\``;
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe(tag);
  });
});

describe("recognized python tags", () => {
  it.each(["python", "python3", "py"])("extracts tag %s", (tag) => {
    const md = `\`\`\`${tag}\nprint("hi")\n\`\`\``;
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe(tag);
  });
});

describe("recognized javascript/typescript tags", () => {
  it.each(["javascript", "js", "node"])("extracts tag %s", (tag) => {
    const md = `\`\`\`${tag}\nconsole.log(1)\n\`\`\``;
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe(tag);
  });

  it.each(["typescript", "ts"])("extracts tag %s", (tag) => {
    const md = `\`\`\`${tag}\nconst x: number = 1;\n\`\`\``;
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe(tag);
  });
});

// ---------------------------------------------------------------------------
// Prototype-chain safety: tags that are inherited Object properties must not
// be recognized, even though they exist on Object.prototype.
// ---------------------------------------------------------------------------

describe("prototype-chain safety", () => {
  it.each(["toString", "constructor", "__proto__"])("rejects prototype property tag %s", (tag) => {
    const md = `\`\`\`${tag}\nsome code\n\`\`\``;
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ignored: untagged, unknown, multi-word info strings
// ---------------------------------------------------------------------------

describe("ignored fences", () => {
  it("ignores fences with no tag", () => {
    const md = "```\nno tag here\n```";
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });

  it("ignores fences with an unknown tag", () => {
    const md = "```rust\nfn main() {}\n```";
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });

  it("ignores fences with a multi-word info string", () => {
    const md = "```bash --login\necho hi\n```";
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });

  it("ignores fences with tag followed by extra word", () => {
    const md = "```python script.py\npass\n```";
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Document order
// ---------------------------------------------------------------------------

describe("document order", () => {
  it("returns multiple blocks in document order", () => {
    const md = [
      "```bash",
      "echo first",
      "```",
      "some prose",
      "```python",
      "print('second')",
      "```",
      "```ts",
      "const x = 3;",
      "```",
    ].join("\n");

    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.tag).toBe("bash");
    expect(blocks[1]?.tag).toBe("python");
    expect(blocks[2]?.tag).toBe("ts");
  });

  it("skips unknown tags and continues collecting", () => {
    const md = ["```rust", "fn main() {}", "```", "```python", "print('after rust')", "```"].join("\n");

    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe("python");
    expect(blocks[0]?.contents).toBe("print('after rust')");
  });
});

// ---------------------------------------------------------------------------
// Tilde fences
// ---------------------------------------------------------------------------

describe("tilde fences", () => {
  it("extracts a block delimited by ~~~", () => {
    const md = "~~~bash\necho tilde\n~~~";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe("bash");
    expect(blocks[0]?.contents).toBe("echo tilde");
  });

  it("does not close a tilde fence with backticks", () => {
    const md = "~~~bash\necho not closed\n```\nstill content\n~~~";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo not closed\n```\nstill content");
  });

  it("does not close a backtick fence with tildes", () => {
    const md = "```bash\necho not closed\n~~~\nstill content\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo not closed\n~~~\nstill content");
  });
});

// ---------------------------------------------------------------------------
// Variable-length fence closing behaviour
// ---------------------------------------------------------------------------

describe("variable-length fence closing", () => {
  it("a four-backtick fence is not closed by three backticks", () => {
    // The ``` line is content; ```` is the real closing fence.
    const md = "````bash\n```\ninner\n````";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("```\ninner");
  });

  it("a longer closing fence is accepted (>=opening length)", () => {
    const md = "```bash\necho ok\n`````";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo ok");
  });

  it("exactly-matching lengths are accepted", () => {
    const md = "```bash\ncontent\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("content");
  });

  it("four-tilde fence not closed by three tildes", () => {
    const md = "~~~~python\nprint(1)\n~~~\nstill content\n~~~~";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("print(1)\n~~~\nstill content");
  });
});

// ---------------------------------------------------------------------------
// Content preservation
// ---------------------------------------------------------------------------

describe("content preservation", () => {
  it("preserves exact multi-line content", () => {
    const md = ["```bash", "line one", "  indented", "line three", "```"].join("\n");
    const blocks = extractFencedBlocks(md);
    expect(blocks[0]?.contents).toBe("line one\n  indented\nline three");
  });

  it("preserves empty content for an empty block", () => {
    const md = "```bash\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("");
  });

  it("normalises CRLF line endings within content", () => {
    const md = "```bash\r\necho hi\r\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo hi");
  });

  it("allows trailing whitespace on tag line", () => {
    const md = "```bash   \necho hi\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// Indented fences (CommonMark-style, 0–3 leading spaces)
// ---------------------------------------------------------------------------

describe("indented fences", () => {
  it("extracts a three-space-indented bash block inside a numbered list", () => {
    const md = ["1. Run this:", "", "   ```bash", "   echo hi", "   ```"].join("\n");
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe("bash");
    expect(blocks[0]?.contents).toBe("echo hi");
  });

  it("dedents content by the opening fence's indentation, preserving extra indentation", () => {
    const md = ["   ```bash", "   echo hi", "     extra indented", "   ```"].join("\n");
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo hi\n  extra indented");
  });

  it("dedents a content line with less indentation than the fence by only what is present", () => {
    const md = ["   ```bash", " echo hi", "   ```"].join("\n");
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo hi");
  });

  it("does not recognize a fence indented by 4+ spaces", () => {
    const md = ["    ```bash", "    echo hi", "    ```"].join("\n");
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });

  it("preserves existing column-zero behavior", () => {
    const md = "```bash\necho hi\n```";
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contents).toBe("echo hi");
  });
});

// ---------------------------------------------------------------------------
// Unclosed / malformed fences
// ---------------------------------------------------------------------------

describe("unclosed and malformed fences", () => {
  it("discards an unclosed fence at end of document", () => {
    const md = "```bash\necho no close";
    expect(extractFencedBlocks(md)).toHaveLength(0);
  });

  it("does not let an unclosed unknown fence consume subsequent blocks", () => {
    // The unknown fence (`rust`) is opened and then properly closed, so the
    // python block that follows should still be extracted.
    const md = ["```rust", "fn main() {}", "```", "```python", "print('ok')", "```"].join("\n");
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBe("python");
  });
});
