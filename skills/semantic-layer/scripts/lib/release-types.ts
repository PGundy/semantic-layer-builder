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
  // Approve target to its hash without its description, for each item of items that has one. Absent
  // in an entry recorded before descriptions were part of an approval, whose items hold those hashes.
  definitions?: Record<string, string>;
  // Golden name to its recorded rows.
  goldens: Record<string, Record<string, unknown>[]>;
  added: string[];
  changed: string[];
  removed: string[];
  goldens_moved: GoldenMoved[];
  // Goldens the last entry recorded that are drafts now (semlayer goldens unconfirm), left out of this one; absent when none.
  goldens_unconfirmed?: string[];
  // Golden name to the hash of its request (approval-hash.ts requestHash), for each golden of goldens_unconfirmed that
  // has a file; absent when none. The request the owner deferred: semlayer status reads a golden as deferred
  // while it is a draft with this request.
  goldens_unconfirmed_requests?: Record<string, string>;
  // Goldens the last entry recorded whose file is gone (semlayer goldens remove), left out of this one; absent when none.
  goldens_removed?: string[];
}

export interface Changelog {
  version: 1;
  entries: ChangelogEntry[];
}
