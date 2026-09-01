/**
 * Block executor: spawns an interpreter with code fed via stdin, captures
 * combined stdout+stderr in arrival order, and returns bounded execution
 * metadata.  Nonzero exits are results — they are never thrown.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecutionDescriptor } from "./interpreters.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Execution result returned by {@link executeBlock}. */
export interface ExecuteResult {
  /** Retained tail output (UTF-8 text; bounded to 50 KB / 2000 lines). */
  output: string;
  /** Process exit code.  130 when cancelled and the OS supplied no code. */
  exitCode: number;
  /** True when execution was terminated via the provided AbortSignal. */
  cancelled: boolean;
  /** True when earlier output was evicted to stay within tail limits. */
  truncated: boolean;
  /** UTF-8 byte length of {@link output}. */
  outputBytes: number;
  /** Total UTF-8 byte length of all received output (including evicted data). */
  totalBytes: number;
  /** Number of newline characters in {@link output}. */
  outputLines: number;
  /** Total newline characters across all received output. */
  totalLines: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BYTES = 50 * 1024; // 50 KB
const MAX_LINES = 2000;
const GRACE_MS = 300; // ms between SIGTERM and SIGKILL escalation
const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// TailBuffer — bounded incremental output accumulator
// ---------------------------------------------------------------------------

interface Chunk {
  text: string;
  bytes: number;
  lines: number;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") n++;
  }
  return n;
}

/**
 * Trims `text` so it fits within {@link MAX_BYTES} and {@link MAX_LINES},
 * keeping the tail (end) of the string.  Applied when a single large chunk
 * cannot be evicted because it is the only remaining chunk.
 */
function tailTrim(text: string): string {
  // Line-trim first: remove leading content until ≤ MAX_LINES newlines remain.
  const nl = countNewlines(text);
  if (nl > MAX_LINES) {
    const toRemove = nl - MAX_LINES;
    let removed = 0;
    let pos = 0;
    while (pos < text.length && removed < toRemove) {
      if (text[pos] === "\n") removed++;
      pos++;
    }
    text = text.slice(pos);
  }

  // Byte-trim: keep the last MAX_BYTES bytes aligned to a UTF-8 char boundary.
  const byteLen = Buffer.byteLength(text, "utf8");
  if (byteLen > MAX_BYTES) {
    const buf = Buffer.from(text, "utf8");
    let start = buf.length - MAX_BYTES;
    // Advance past any UTF-8 continuation bytes to reach a character start.
    while (start < buf.length && ((buf.at(start) ?? 0) & 0xc0) === 0x80) start++;
    text = buf.slice(start).toString("utf8");
  }

  return text;
}

class TailBuffer {
  private readonly chunks: Chunk[] = [];

  retainedBytes = 0;
  retainedLines = 0;
  totalBytes = 0;
  totalLines = 0;
  truncated = false;

  push(text: string): void {
    if (!text) return;

    const bytes = Buffer.byteLength(text, "utf8");
    const lines = countNewlines(text);

    // Always count totals, even for data that will be evicted.
    this.totalBytes += bytes;
    this.totalLines += lines;

    this.chunks.push({ text, bytes, lines });
    this.retainedBytes += bytes;
    this.retainedLines += lines;

    // Evict oldest chunks while over either limit (always retain at least one).
    while (this.chunks.length > 1 && (this.retainedBytes > MAX_BYTES || this.retainedLines > MAX_LINES)) {
      const evicted = this.chunks.shift();
      if (evicted) {
        this.retainedBytes -= evicted.bytes;
        this.retainedLines -= evicted.lines;
      }
      this.truncated = true;
    }

    // Single-chunk overflow: trim in-place so the bound always holds even when
    // the OS delivers a single large chunk (e.g. the entire pipe buffer at once).
    if (this.chunks.length === 1 && (this.retainedBytes > MAX_BYTES || this.retainedLines > MAX_LINES)) {
      const first = this.chunks[0];
      if (!first) return;
      const trimmed = tailTrim(first.text);
      const trimmedBytes = Buffer.byteLength(trimmed, "utf8");
      const trimmedLines = countNewlines(trimmed);
      this.chunks[0] = { text: trimmed, bytes: trimmedBytes, lines: trimmedLines };
      this.retainedBytes = trimmedBytes;
      this.retainedLines = trimmedLines;
      this.truncated = true;
    }
  }

  result(): Omit<ExecuteResult, "exitCode" | "cancelled"> {
    const output = this.chunks.map((c) => c.text).join("");
    return {
      output,
      truncated: this.truncated,
      outputBytes: this.retainedBytes,
      totalBytes: this.totalBytes,
      outputLines: this.retainedLines,
      totalLines: this.totalLines,
    };
  }
}

// ---------------------------------------------------------------------------
// Process-group kill helpers (POSIX only)
// ---------------------------------------------------------------------------

function sendSignalToGroup(pid: number, sig: "SIGTERM" | "SIGKILL", fallbackKill: () => void): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // Group kill failed; fall back to a direct child signal if the process is still live.
    try {
      process.kill(pid, 0); // throws ESRCH when the process is already gone
      fallbackKill();
    } catch {
      // Process already gone or unreachable.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawns `descriptor.command` with `descriptor.args`, feeds `code` via stdin,
 * captures combined stdout+stderr in arrival order, and resolves with an
 * {@link ExecuteResult}.  Nonzero exit codes are returned as results and are
 * never thrown.
 *
 * Output is tail-bounded to 50 KB / 2000 lines and older data is evicted
 * incrementally — full output is never held in memory.
 *
 * If `signal` is already aborted the function returns immediately without
 * spawning.  If `signal` fires during execution the process group receives
 * SIGTERM (POSIX) or a direct kill (Windows); a SIGKILL escalation is issued
 * after {@link GRACE_MS} ms if the process has not yet exited.
 */
export async function executeBlock(
  descriptor: ExecutionDescriptor,
  code: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ExecuteResult> {
  // Pre-abort: return immediately without spawning.
  if (signal?.aborted) {
    return {
      output: "",
      exitCode: 130,
      cancelled: true,
      truncated: false,
      outputBytes: 0,
      totalBytes: 0,
      outputLines: 0,
      totalLines: 0,
    };
  }

  return new Promise<ExecuteResult>((resolve) => {
    const child = spawn(descriptor.command, descriptor.args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WINDOWS, // own process group on POSIX for group-kill support
    });

    const buf = new TailBuffer();
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");

    let cancelled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let onAbort: (() => void) | undefined;
    let stdoutFlushed = false;
    let stderrFlushed = false;

    function settle(exitCode: number, isCancelled: boolean): void {
      if (settled) return;
      settled = true;

      // Remove the abort listener to prevent a late-fire after settlement.
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }

      // Cancel the SIGKILL escalation timer if the process exited on its own.
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }

      // Defensive flush for any decoder not yet flushed by its stream's end event
      // (e.g. spawn error path where streams may not emit end before close).
      if (!stdoutFlushed) {
        stdoutFlushed = true;
        const tail = stdoutDec.end();
        if (tail) buf.push(tail);
      }
      if (!stderrFlushed) {
        stderrFlushed = true;
        const tail = stderrDec.end();
        if (tail) buf.push(tail);
      }

      resolve({ ...buf.result(), exitCode, cancelled: isCancelled });
    }

    // Interleave stdout and stderr in arrival order.
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDec.write(chunk);
      if (text) buf.push(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDec.write(chunk);
      if (text) buf.push(text);
    });

    // Flush each decoder on stream end to capture any trailing incomplete
    // multi-byte sequence in stream-end arrival order.
    child.stdout?.on("end", () => {
      if (!stdoutFlushed) {
        stdoutFlushed = true;
        const tail = stdoutDec.end();
        if (tail) buf.push(tail);
      }
    });

    child.stderr?.on("end", () => {
      if (!stderrFlushed) {
        stderrFlushed = true;
        const tail = stderrDec.end();
        if (tail) buf.push(tail);
      }
    });

    // Suppress EPIPE / stream errors when the child exits before we finish writing.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.on("close", (code) => {
      // code is null when the process was killed by a signal.
      settle(code ?? (cancelled ? 130 : 1), cancelled);
    });

    child.on("error", () => {
      // Fires when the process could not be spawned or could not be killed.
      // A close event may follow on Node.js v22+ for spawn failures; settle is idempotent.
      settle(1, cancelled);
    });

    // Feed the code via stdin and close the write end.
    child.stdin?.end(code, "utf8");

    // Wire the abort signal if one was provided.
    if (signal) {
      onAbort = (): void => {
        if (settled) return;

        // Do not mark cancelled until we confirm a PID exists; if spawn has
        // already failed (pid === undefined) the error handler settles with
        // cancelled=false and exitCode 1.
        const { pid } = child;
        if (pid === undefined) return;

        cancelled = true;

        // Terminate the process group (POSIX) or the child directly (Windows).
        if (IS_WINDOWS) {
          child.kill("SIGTERM");
        } else {
          sendSignalToGroup(pid, "SIGTERM", () => {
            child.kill("SIGTERM");
          });
        }

        // Escalate to SIGKILL after the grace period.
        graceTimer = setTimeout(() => {
          if (settled) return;
          if (IS_WINDOWS) {
            child.kill();
          } else {
            sendSignalToGroup(pid, "SIGKILL", () => {
              child.kill("SIGKILL");
            });
          }
        }, GRACE_MS);
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
