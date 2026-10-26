import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Document, parse, parseDocument, stringify } from "yaml";
import { UserError } from "./errors.ts";

const STRINGIFY = { lineWidth: 0, indent: 2 } as const;

export function readYaml<T>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    return parse(text) as T;
  } catch (e) {
    throw new UserError(`${path}: invalid YAML: ${(e as Error).message}`);
  }
}

export function readYamlIfExists<T>(path: string): T | null {
  return existsSync(path) ? readYaml<T>(path) : null;
}

// Writes a new file from a plain object. Use updateYaml to edit an existing file.
export function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(value, STRINGIFY));
}

// Edits an existing YAML file in place, keeping the owner's comments and ordering.
export function updateYaml(path: string, edit: (doc: Document) => void): void {
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length) throw new UserError(`${path}: invalid YAML: ${doc.errors[0]!.message}`);
  edit(doc);
  writeFileSync(path, doc.toString(STRINGIFY));
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new UserError(`${path}: invalid JSON: ${(e as Error).message}`);
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
