// The shapes of changelog.yaml (spec: Iterating a layer, The changelog); schemas/changelog.schema.json
// is their JSON Schema.

// A golden whose recorded rows differ from the previous entry's, with cell counts.
export interface GoldenMoved {
  golden: string;
  before: number;
  after: number;
  changed: number;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  note: string;
  // Approve target to content hash.
  items: Record<string, string>;
  // Golden name to its recorded rows.
  goldens: Record<string, Record<string, unknown>[]>;
  added: string[];
  changed: string[];
  removed: string[];
  goldens_moved: GoldenMoved[];
}

export interface Changelog {
  version: 1;
  entries: ChangelogEntry[];
}
