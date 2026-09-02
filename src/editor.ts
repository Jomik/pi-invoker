/**
 * External-editor helper for "Edit before running".
 *
 * Adapted from Pi's own external-editor implementation
 * (`@earendil-works/pi-coding-agent`'s `editInExternalEditor`), but operating
 * on a temporary script file (named and suffixed for the block's language
 * tag) instead of a prompt file.
 *
 * Resolution order for the editor command: `$VISUAL`, then `$EDITOR`, then
 * the platform default (`notepad` on Windows, `nano` elsewhere). Command
 * splitting matches Pi's existing behavior (a plain space split — no shell
 * parsing, no quoting support).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Suffix mapping
// ---------------------------------------------------------------------------

/**
 * Fixed, safe suffixes for recognized fence tags. Unknown tags always map to
 * `.txt` — the tag itself is never interpolated into a path.
 */
const SUFFIX_MAP: Record<string, string> = {
  sh: ".sh",
  shell: ".sh",
  bash: ".sh",
  zsh: ".zsh",
  fish: ".fish",
  py: ".py",
  python: ".py",
  python3: ".py",
  js: ".js",
  javascript: ".js",
  node: ".js",
  ts: ".ts",
  typescript: ".ts",
};

/** Maps a fence tag to a safe, fixed filename suffix (`.txt` when unrecognized). */
export function suffixForTag(tag: string): string {
  return Object.hasOwn(SUFFIX_MAP, tag) ? (SUFFIX_MAP[tag] as string) : ".txt";
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

/** Resolves the editor command: `$VISUAL`, then `$EDITOR`, then the platform default. */
function resolveEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
}

// ---------------------------------------------------------------------------
// BOM stripping
// ---------------------------------------------------------------------------

/** Removes a leading UTF-8 byte order mark, consistent with Pi's stripBom. */
function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/**
 * Quotes a path for cmd.exe (used when spawning with `shell: true` on
 * Windows) so spaces or other metacharacters in the temp directory are not
 * split into separate arguments. This is a fixed, single-purpose quoting
 * step for our own generated temp file path — not a general shell parser.
 */
function quoteForWindowsShell(value: string): string {
  return `"${value}"`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes `code` to a fresh `pi-invoker-` temp directory as `script<suffix>`
 * (suffix derived from `tag` via {@link suffixForTag}), launches the
 * resolved external editor on that file with inherited stdio, and — on a
 * clean (zero) exit — returns the edited content with a leading BOM and one
 * trailing newline stripped, consistent with Pi's own editor handling.
 *
 * Returns `null` when the editor could not be spawned or exited nonzero.
 * The temporary directory is always removed before returning.
 */
export async function editInExternalEditor(code: string, tag: string): Promise<string | null> {
  const directory = mkdtempSync(join(tmpdir(), "pi-invoker-"));
  const filePath = join(directory, `script${suffixForTag(tag)}`);
  try {
    writeFileSync(filePath, code, "utf-8");

    const command = resolveEditorCommand();
    const [editor, ...editorArgs] = command.split(" ");
    if (!editor) return null;

    const isWindows = process.platform === "win32";
    const finalArg = isWindows ? quoteForWindowsShell(filePath) : filePath;

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(editor, [...editorArgs, finalArg], {
        stdio: "inherit",
        shell: isWindows,
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });

    if (exitCode !== 0) return null;

    return stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "");
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort.
    }
  }
}
