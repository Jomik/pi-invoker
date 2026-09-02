import { isRecognizedTag, type RecognizedTag } from "./interpreters.js";

/** A fenced code block whose info string is a single recognized language tag. */
export interface FencedBlock {
  /** The exact tag from the opening fence info string (e.g. `"bash"`, `"ts"`). */
  tag: RecognizedTag;
  /** Full verbatim code contents between the opening and closing fence lines. */
  contents: string;
}

// Matches an opening fence line:
//   group 1 — leading indentation (0–3 ASCII spaces, CommonMark-style)
//   group 2 — fence run (3+ identical backticks or tildes)
//   group 3 — info string (first non-whitespace word); fails if empty or multi-word
const OPENING_FENCE_RE = /^( {0,3})(`{3,}|~{3,})(\S+)\s*$/;

/**
 * Returns true when `line` is a valid closing fence for a fence opened with
 * `fenceChar` repeated `minLen` times.  Up to 3 leading ASCII spaces are
 * allowed (CommonMark-style), and trailing whitespace on the line is
 * ignored; the remaining characters must all be `fenceChar`.
 */
function isClosingFence(line: string, fenceChar: string, minLen: number): boolean {
  const leadingSpacesMatch = /^ {0,3}/.exec(line);
  const afterIndent = line.slice(leadingSpacesMatch === null ? 0 : leadingSpacesMatch[0].length);
  const trimmed = afterIndent.trimEnd();
  if (trimmed.length < minLen) return false;
  for (const ch of trimmed) {
    if (ch !== fenceChar) return false;
  }
  return true;
}

/**
 * Removes up to `indent.length` leading ASCII spaces from `line`, stopping
 * early if `line` has fewer leading spaces than `indent`.  Any additional
 * indentation beyond `indent.length` is preserved.
 */
function dedent(line: string, indent: string): string {
  let i = 0;
  while (i < indent.length && i < line.length && line[i] === " ") {
    i++;
  }
  return line.slice(i);
}

/**
 * Extracts all fenced code blocks from `markdown` whose opening info string
 * is exactly one recognized language tag (as defined in `interpreters.ts`).
 *
 * Blocks are returned in document order.  Fences may use backticks or tildes
 * (≥ 3 of the same character).  A closing fence must use the same character
 * and be at least as long as the opening fence; longer outer fences containing
 * shorter fence text are handled correctly.  Unclosed fences are discarded.
 */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  // Normalize all line endings so the logic only needs to handle \n.
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const results: FencedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const openMatch = OPENING_FENCE_RE.exec(line);

    if (openMatch === null) {
      i++;
      continue;
    }

    const indent = openMatch[1];
    const fenceRun = openMatch[2];
    const tag = openMatch[3];
    const fenceChar = fenceRun[0];
    const fenceLen = fenceRun.length;

    // Advance past the opening fence line.
    i++;

    // Collect content lines until a matching closing fence or end-of-input.
    const contentLines: string[] = [];
    let closed = false;

    while (i < lines.length) {
      const contentLine = lines[i];

      if (isClosingFence(contentLine, fenceChar, fenceLen)) {
        closed = true;
        i++; // consume closing fence
        break;
      }

      contentLines.push(dedent(contentLine, indent));
      i++;
    }

    // Discard unclosed fences.
    if (!closed) continue;

    // Only emit blocks with a recognized tag.
    if (!isRecognizedTag(tag)) continue;

    results.push({ tag, contents: contentLines.join("\n") });
  }

  return results;
}
