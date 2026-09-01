/**
 * Canonical mapping of recognized Markdown fenced-block language tags to the
 * interpreter that executes them.  Resolution logic (PATH probing, Node version
 * validation, …) is added in task 2; this module owns the single source of
 * truth for which tags are recognized and what interpreter they name.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const TAG_TO_INTERPRETER = {
  sh: "sh",
  shell: "sh",
  bash: "bash",
  zsh: "zsh",
  fish: "fish",
  python: "python3",
  python3: "python3",
  py: "python3",
  javascript: "node",
  js: "node",
  node: "node",
  typescript: "node",
  ts: "node",
} as const satisfies Record<string, string>;

/** Union of every recognized language tag. */
export type RecognizedTag = keyof typeof TAG_TO_INTERPRETER;

/** Returns true (and narrows the type) when `tag` is a recognized language tag. */
export function isRecognizedTag(tag: string): tag is RecognizedTag {
  return Object.hasOwn(TAG_TO_INTERPRETER, tag);
}

// ---------------------------------------------------------------------------
// Execution descriptor
// ---------------------------------------------------------------------------

/** A resolved execution descriptor: the command and interpreter-level arguments. */
export interface ExecutionDescriptor {
  /** Absolute path to the interpreter executable. */
  command: string;
  /** Interpreter-level arguments prepended before code is fed via stdin. */
  args: string[];
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when a required shell or Python interpreter cannot be found on PATH. */
export class MissingInterpreterError extends Error {
  constructor(public readonly interpreter: string) {
    super(`Interpreter not found on PATH: ${interpreter}`);
    this.name = "MissingInterpreterError";
  }
}

/** Thrown when the current Node.js runtime is too old to execute TypeScript. */
export class UnsupportedRuntimeError extends Error {
  constructor(public readonly version: string) {
    super(`TypeScript execution requires Node.js >= 22.19; current runtime is ${version}`);
    this.name = "UnsupportedRuntimeError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MIN_TS_MAJOR = 22;
const MIN_TS_MINOR = 19;

function parseNodeVersion(version: string): { major: number; minor: number } {
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  const parts = stripped.split(".");
  return {
    major: Number.parseInt(parts[0] ?? "0", 10),
    minor: Number.parseInt(parts[1] ?? "0", 10),
  };
}

function supportsTypeScript(version: string): boolean {
  const { major, minor } = parseNodeVersion(version);
  return major > MIN_TS_MAJOR || (major === MIN_TS_MAJOR && minor >= MIN_TS_MINOR);
}

/**
 * Searches `pathEnv` (a PATH-format string) for an executable named `name`.
 * On Windows the search iterates through PATHEXT extensions.  Returns the
 * absolute path on success, or `null` when the executable is absent.
 */
function findOnPath(name: string, pathEnv: string): string | null {
  const dirs = pathEnv.split(delimiter);
  const isWindows = process.platform === "win32";
  const accessFlag = isWindows ? constants.F_OK : constants.X_OK;
  const extensions: string[] = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, accessFlag);
        if (!statSync(candidate).isFile()) continue;
        return candidate;
      } catch {
        // not accessible or not a file — try next candidate
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public resolution API
// ---------------------------------------------------------------------------

/** Options accepted by {@link resolveInterpreter} — primarily for testing. */
export interface ResolveOptions {
  /**
   * Override the Node.js version string used for TypeScript version checks.
   * Defaults to `process.version`.
   */
  nodeVersion?: string;
  /**
   * Override the PATH string used when searching for shell/Python executables.
   * Defaults to `process.env["PATH"]`.
   */
  pathEnv?: string;
}

/**
 * Resolves a recognized language tag to an {@link ExecutionDescriptor}.
 *
 * - `javascript` / `js` / `node` → `process.execPath`, no extra args.
 * - `typescript` / `ts` → `process.execPath` with `--input-type=module-typescript`;
 *   throws {@link UnsupportedRuntimeError} when Node < 22.19.
 * - Shell / Python tags → absolute path located on PATH; throws
 *   {@link MissingInterpreterError} if the interpreter is absent.
 */
export function resolveInterpreter(tag: RecognizedTag, options: ResolveOptions = {}): ExecutionDescriptor {
  const nodeVersion = options.nodeVersion ?? process.version;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";

  if (TAG_TO_INTERPRETER[tag] === "node") {
    if (tag === "typescript" || tag === "ts") {
      if (!supportsTypeScript(nodeVersion)) {
        throw new UnsupportedRuntimeError(nodeVersion);
      }
      return { command: process.execPath, args: ["--input-type=module-typescript"] };
    }
    return { command: process.execPath, args: [] };
  }

  // Shell or Python: locate on host PATH.
  const interpreter = TAG_TO_INTERPRETER[tag];
  const found = findOnPath(interpreter, pathEnv);
  if (found === null) {
    throw new MissingInterpreterError(interpreter);
  }
  return { command: found, args: [] };
}
