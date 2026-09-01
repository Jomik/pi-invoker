/**
 * Canonical mapping of recognized Markdown fenced-block language tags to the
 * interpreter that executes them.  Resolution logic (PATH probing, Node version
 * validation, …) is added in task 2; this module owns the single source of
 * truth for which tags are recognized and what interpreter they name.
 */

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
