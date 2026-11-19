// Every approval entry of a semantic root as its files stand, read through the loaders of project.ts
// and listed by listApprovals (approval-hash.ts): models, fields, joins, metrics, access.yaml and
// goldens, each with its file. With goldens false, the goldens are not read.
import { type Approval, listApprovals } from "./approval-hash.ts";
import { listGoldens, listModels, loadAccess, loadMetrics, loadSource, paths } from "./project.ts";
import type { Dialect } from "./types.ts";

export function projectApprovals(root: string, goldens = true): Approval[] {
  const models = listModels(root);
  const dialects = new Map<string, Dialect | undefined>();
  const dialect = (source: string): Dialect | undefined => {
    if (!dialects.has(source)) {
      let d: Dialect | undefined;
      try {
        d = loadSource(root, source).dialect;
      } catch {
        d = undefined;
      }
      dialects.set(source, d);
    }
    return dialects.get(source);
  };
  return listApprovals({
    models: models.map(({ path, model }) => ({
      source: model.source,
      model,
      file: path,
      lookup: (name: string) => models.find((m) => m.model.source === model.source && m.model.model === name)?.model,
      dialect: dialect(model.source),
    })),
    metrics: loadMetrics(root).metrics,
    metricsFile: paths(root).metrics,
    access: loadAccess(root),
    accessFile: paths(root).access,
    goldens: goldens ? listGoldens(root).map(({ path, golden }) => ({ golden, file: path })) : [],
  });
}
