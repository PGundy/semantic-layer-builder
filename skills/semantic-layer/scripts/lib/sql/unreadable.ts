// The relations a Postgres role cannot read, so introspection can say which it skipped.
// It asks the same question the introspection queries do (lib/sql/introspection.ts), reversed.
import type { PlannedQuery, QueryPlan, ResultRows, SourceConfig } from "../types.ts";
import { POSTGRES_READABLE, POSTGRES_RELATION, postgresSchemaFilter } from "./introspection.ts";

export interface UnreadableRelation {
  schema: string;
  name: string;
}

// A one-query plan, or null for a dialect whose introspection applies no privilege test.
export function unreadablePlan(source: SourceConfig, schemas: string[]): QueryPlan | null {
  if (source.dialect !== "postgres") return null;
  const query: PlannedQuery = {
    id: "unreadable",
    purpose: "Relations the role has no SELECT on, which introspection leaves out",
    sql: `select n.nspname as table_schema, c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where ${POSTGRES_RELATION}
  and not ${POSTGRES_READABLE("c")}
  and ${postgresSchemaFilter("n", schemas)}
order by 1, 2`,
  };
  return { command: "introspect", source: source.source, dialect: source.dialect, queries: [query] };
}

export function unreadableFrom(rows: ResultRows): UnreadableRelation[] {
  return rows.map((r) => ({ schema: String(r.table_schema), name: String(r.table_name) }));
}

// The relations the plain line names; a longer list is cut here, and --json carries all of it.
const SHOWN = 10;

// One plain line, or null when nothing was skipped. It names the first SHOWN relations and counts the rest.
export function unreadableLine(list: UnreadableRelation[], source: string): string | null {
  if (!list.length) return null;
  const shown = list.slice(0, SHOWN).map((r) => `${r.schema}.${r.name}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
  const more = list.length - shown.length;
  const names = more > 0 ? `${shown.join(", ")} and ${more} more (all of them are in --json, as skipped_unreadable)` : shown.join(", ");
  return (
    `Skipped ${list.length} ${list.length === 1 ? "relation" : "relations"} this role cannot read: ${names}. ` +
    `To include ${list.length === 1 ? "it" : "them"}, grant SELECT on ${list.length === 1 ? "it" : "them"} to the role and rerun semlayer introspect --source ${source}.`
  );
}
