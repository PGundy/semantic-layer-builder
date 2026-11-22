// Every approval entry of a semantic root as its files stand, read through the loaders of project.ts
// and listed by listApprovals (approval-hash.ts): models, fields, joins, metrics, access.yaml and
// goldens, each with its file. With goldens false, the goldens are not read.
import { type Approval, listApprovals } from "./approval-hash.ts";
import { listGoldens, listModels, listSourceNames, loadAccess, loadMetrics, loadSource, paths } from "./project.ts";
import { sourceWeekStart, type WeekDay } from "./compiler/calendar.ts";
import type { Dialect } from "./types.ts";

export function projectApprovals(root: string, goldens = true): Approval[] {
  const models = listModels(root);
  const scopes = new Map<string, { dialect: Dialect | undefined; weekStart: WeekDay | undefined }>();
  const scope = (source: string) => {
    if (!scopes.has(source)) {
      try {
        const config = loadSource(root, source);
        scopes.set(source, { dialect: config.dialect, weekStart: sourceWeekStart(config) });
      } catch {
        scopes.set(source, { dialect: undefined, weekStart: undefined });
      }
    }
    return scopes.get(source)!;
  };
  return listApprovals({
    models: models.map(({ path, model }) => ({
      source: model.source,
      model,
      file: path,
      lookup: (name: string) => models.find((m) => m.model.source === model.source && m.model.model === name)?.model,
      ...scope(model.source),
    })),
    sources: listSourceNames(root).map((source) => ({ source, config: loadSource(root, source), file: paths(root).source(source) })),
    metrics: loadMetrics(root).metrics,
    metricsFile: paths(root).metrics,
    access: loadAccess(root),
    accessFile: paths(root).access,
    goldens: goldens ? listGoldens(root).map(({ path, golden }) => ({ golden, file: path })) : [],
  });
}
