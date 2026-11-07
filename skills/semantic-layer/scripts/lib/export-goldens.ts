// Decision D2: a golden whose source is an export source (intake.mode: export) cannot be confirmed
// until that source has a connection, since a golden's rows come from the data. Every command that
// names the steps for such a golden (sl readback, sl reply, sl review apply, sl goldens) takes their
// wording from here, so the upgrade and what follows it read the same everywhere.
import { intakeMode, upgradeCommand } from "./intake.ts";
import { paths } from "./project.ts";
import type { Dialect, SourceConfig } from "./types.ts";
import { readYamlIfExists } from "./yaml.ts";

interface ExportSource {
  source: string;
  dialect: Dialect;
}

// The export source a golden reads from (its request.source, when sources/<source>.yaml has intake
// mode export), or undefined for a connection source or a golden or source that cannot be read, whose
// own command then says what is wrong.
export function goldenExportSource(root: string, golden: string): ExportSource | undefined {
  try {
    const g = readYamlIfExists<{ request?: { source?: unknown } }>(paths(root).golden(golden));
    const name = g?.request?.source;
    if (typeof name !== "string" || !name) return undefined;
    const source = readYamlIfExists<SourceConfig>(paths(root).source(name));
    if (!source || typeof source !== "object" || intakeMode(source) !== "export") return undefined;
    return { source: name, dialect: source.dialect };
  } catch {
    return undefined;
  }
}

const joined = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// The commands for goldens of one export source: the upgrade, then each golden's confirm (or its
// run, before the owner has said yes to it).
export function goldenUpgradeNext(source: string, dialect: Dialect, goldens: readonly string[], then: "confirm" | "run" = "confirm"): string {
  return `${upgradeCommand(source, dialect)}, then ${joined(goldens.map((g) => `sl goldens ${then} --name ${g}`))}`;
}

// The step for yeses to goldens of one export source: why they wait, the upgrade, then each confirm.
function goldenUpgradeStep(source: string, dialect: Dialect, goldens: readonly string[]): string {
  return `${joined(goldens.map((g) => `golden:${g}`))} cannot be confirmed until source ${source} has a connection: ${goldenUpgradeNext(source, dialect, goldens)}`;
}

// The steps to run once the owner says yes to each target, in the targets' order: the goldens of an
// export source are named together, by goldenUpgradeStep, once per source at the place of its first
// golden; every other target by its own step.
export function afterYesSteps(root: string, targets: readonly string[], step: (target: string) => string): string[] {
  const steps: (string | (ExportSource & { goldens: string[] }))[] = [];
  for (const t of targets) {
    const waits = t.startsWith("golden:") ? goldenExportSource(root, t.slice(7)) : undefined;
    if (!waits) {
      steps.push(step(t));
      continue;
    }
    const group = steps.find((x): x is ExportSource & { goldens: string[] } => typeof x !== "string" && x.source === waits.source);
    if (!group) steps.push({ ...waits, goldens: [t.slice(7)] });
    else if (!group.goldens.includes(t.slice(7))) group.goldens.push(t.slice(7));
  }
  return steps.map((x) => (typeof x === "string" ? x : goldenUpgradeStep(x.source, x.dialect, x.goldens)));
}
