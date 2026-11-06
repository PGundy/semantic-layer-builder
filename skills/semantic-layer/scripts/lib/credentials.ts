// Detects credentials in the values a DuckDB source keeps in its file: the database, the setup
// statements and the view relations. Callers never echo a value that fails: it may hold the secret.

// user:password@ inside a URL.
const URL_CREDENTIALS = /:\/\/[^/\s'"]*@/;
// A key named like a credential set to a quoted literal, as in SET s3_secret_access_key='...',
// CREATE SECRET (KEY_ID '...', SECRET '...') or SET azure_storage_connection_string='...'.
const QUOTED_CREDENTIAL =
  /([A-Za-z0-9_]*(?:secret|key_id|access_key|password|passwd|token|account_key|connection_string|client_secret)[A-Za-z0-9_]*)\s*[=:]?\s*'[^']+'/gi;
// Settings whose names look like credentials but hold none.
const NOT_CREDENTIALS = new Set(["secret_directory"]);
// key=value inside a string: libpq 'password=...', 'AccountKey=...', 'md:db?motherduck_token=...', SAS '&sig=...'.
const INLINE_CREDENTIAL =
  /(?:^|[^A-Za-z0-9_])(?:password|passwd|pwd|[A-Za-z0-9_]*token|[A-Za-z0-9_]*secret[A-Za-z0-9_]*|accountkey|account_key|sharedaccesssignature|sig)\s*=\s*[^\s'"]/i;

// Where a value sits: database is a path or URL; setup is a statement that may assign settings;
// view is a relation, whose string literals (paths, URLs) are checked.
export type CredentialSlot = "database" | "setup" | "view";

export function hasCredential(slot: CredentialSlot, value: string): boolean {
  if (slot === "view") {
    return [...value.matchAll(/'([^']*)'/g)].some((m) => URL_CREDENTIALS.test(m[1] ?? "") || INLINE_CREDENTIAL.test(m[1] ?? ""));
  }
  if (URL_CREDENTIALS.test(value) || INLINE_CREDENTIAL.test(value)) return true;
  if (slot === "database") return false;
  for (const m of value.matchAll(QUOTED_CREDENTIAL)) {
    if (!NOT_CREDENTIALS.has((m[1] ?? "").toLowerCase())) return true;
  }
  return false;
}

// Where the credential goes instead, per slot.
export const SECRET_HINT =
  "use a secret provider that reads the environment instead, for example CREATE SECRET (TYPE s3, PROVIDER credential_chain).";
export const DATABASE_HINT =
  "put the token in an environment variable (MOTHERDUCK_TOKEN for md: databases) or a DuckDB secret provider, and pass the database without it.";

export function credentialHint(slot: CredentialSlot): string {
  return slot === "database" ? DATABASE_HINT : SECRET_HINT;
}

// Text with every credential the patterns above recognise replaced by [redacted], keeping the key
// so the reader sees what was removed: the user:password of a URL, a credential-named key set to a
// quoted literal or a bare value (libpq password=..., AccountKey=..., PGPASSWORD=..., &sig=...),
// and an Authorization bearer token. Used on free text an owner types, which a CLI then stores.
const REDACT_URL = /(:\/\/)[^/\s'"]*@/g;
const CREDENTIAL_KEY =
  "[A-Za-z0-9_]*(?:secret|key_id|access_key|password|passwd|pwd|token|account_key|accountkey|connection_string|sharedaccesssignature)[A-Za-z0-9_]*|sig";
// After = any value counts; after a colon (as in "password: ...") a quoted one, or a bare one of 8
// or more characters mixing letters and digits, so "password_hash: drop it" stays as written; with
// no separator (KEY_ID '...', SECRET '...', as QUOTED_CREDENTIAL accepts) a quoted one.
const REDACT_KEY_VALUE = new RegExp(
  `(?<![A-Za-z0-9_])(${CREDENTIAL_KEY})(\\s*=\\s*|\\s*:\\s*(?='|"|(?=[^\\s'"&;,]*[0-9])(?=[^\\s'"&;,]*[A-Za-z])[^\\s'"&;,]{8})|\\s*(?='|"))('[^']*'|"[^"]*"|[^\\s'"&;,]+)`,
  "gi",
);
const REDACT_BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
export const REDACTED = "[redacted]";

export function redactCredentials(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const mark = () => ((redacted = true), REDACTED);
  const out = text
    .replace(REDACT_URL, (_all, scheme: string) => `${scheme}${mark()}@`)
    .replace(REDACT_KEY_VALUE, (all, key: string, sep: string, value: string) =>
      NOT_CREDENTIALS.has(key.toLowerCase()) || value === REDACTED ? all : `${key}${sep}${value.startsWith("'") ? `'${mark()}'` : value.startsWith('"') ? `"${mark()}"` : mark()}`,
    )
    .replace(REDACT_BEARER, (_all, lead: string) => `${lead}${mark()}`);
  return { text: out, redacted };
}
