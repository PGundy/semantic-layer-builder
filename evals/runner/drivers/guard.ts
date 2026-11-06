// Which tool calls the sdk driver's skill agent may make. It reads only the working root and the
// skill's own files, writes only inside the root, and runs only the sl CLI there, so it cannot
// open the owner's brief, the fixture's reference figures or earlier runs.
import { isAbsolute, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../files.ts";

export const SKILL_DIR = join(REPO_ROOT, "skills", "semantic-layer");
export const SL = join(SKILL_DIR, "scripts", "sl.ts");
// The tools the skill agent has; the guard checks every call to them.
export const SKILL_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];

const inside = (path: string, dir: string) => {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
// A path segment "..", or a path that starts at / or ~, anywhere in the text.
const LEAVES_ROOT = /(^|[^A-Za-z0-9_.])\.\.([/\\]|$)|(^|[\s=('",])(\/|~\/|\\)\S/;
// A glob's fixed part, before its first wildcard.
const fixedPart = (pattern: string) => pattern.split(/[*?[{]/)[0] ?? "";

// Returns why the call is refused, or undefined when it may run.
export function refuseSkillTool(tool: string, input: Record<string, unknown>, root: string): string | undefined {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const readable = (p: string) => inside(resolve(root, p), root) || inside(resolve(root, p), SKILL_DIR);
  const outside = "it is outside the semantic root and the skill's files; work from the files in the current directory.";
  switch (tool) {
    case "Read":
      return readable(str("file_path") ?? "") ? undefined : `Reading ${str("file_path")} is refused: ${outside}`;
    case "Glob":
    case "Grep": {
      const path = str("path") ?? ".";
      const pattern = tool === "Glob" ? (str("pattern") ?? "") : (str("glob") ?? "");
      const patternOk = isAbsolute(pattern) ? readable(fixedPart(pattern)) : !LEAVES_ROOT.test(pattern);
      return readable(path) && patternOk ? undefined : `Searching ${path} ${pattern} is refused: ${outside}`;
    }
    case "Write":
    case "Edit": {
      const file = str("file_path") ?? "";
      return inside(resolve(root, file), root) ? undefined : `Writing ${file} is refused: the agent writes only inside the semantic root.`;
    }
    case "Bash": {
      const command = (str("command") ?? "").trim();
      const prefix = `bun ${SL} `;
      const args = command.startsWith(prefix) ? command.slice(prefix.length) : undefined;
      if (args === undefined || /[;&|<>`$\n\r\\]/.test(args) || LEAVES_ROOT.test(args)) {
        return `Running "${command}" is refused: run only \`${prefix}<command> --root .\`, one command at a time, with paths inside the semantic root.`;
      }
      return undefined;
    }
    default:
      return `The ${tool} tool is not available to the skill agent; use ${SKILL_TOOLS.join(", ")}.`;
  }
}
