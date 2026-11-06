// Redacts credentials from text before the harness writes it. The rules are the CLI's own
// (skills/semantic-layer/scripts/lib/credentials.ts): the scans below find the spans those rules
// flag, and when hasCredential still flags what is left, the whole text is redacted.
import { hasCredential } from "../../skills/semantic-layer/scripts/lib/credentials.ts";

export const REDACTED = "[redacted]";

// A URL with user:password@, the whole URL.
const URL_WITH_USER = /[^\s'"()<>[\]{}`]*:\/\/[^/\s'"]*@[^\s'"()<>[\]{}`]*/g;
// A credential-named key set to a quoted literal, as in SET s3_secret_access_key = '...' or
// SECRET '...': the key stays, the literal goes.
const KEY_AND_LITERAL =
  /([A-Za-z0-9_]*(?:secret|key_id|access_key|password|passwd|token|account_key|connection_string|client_secret)[A-Za-z0-9_]*)(\s*[=:]?\s*)'[^']+'/gi;
const NOT_CREDENTIALS = new Set(["secret_directory"]);
// key=value, as in password = hunter2, 'md:db?motherduck_token=...' or SAS '&sig=...': the key
// stays, the value goes. A value ends at whitespace, a quote, & or ;, and trailing sentence marks
// stay. A double-quoted value is redacted too.
const KEY_AND_VALUE =
  /(^|[^A-Za-z0-9_])((?:password|passwd|pwd|[A-Za-z0-9_]*token|[A-Za-z0-9_]*secret[A-Za-z0-9_]*|accountkey|account_key|sharedaccesssignature|sig)\s*=\s*)("[^"\n]+"|[^\s'"&;]+?(?=[.,:!?)\]}>]*(?:[\s'"&;]|$)))/gi;

// True when the rules flag a part of the text between the redactions.
const stillFlagged = (text: string) => text.split(REDACTED).some((part) => hasCredential("setup", part));

export function redactSecrets(text: string): string {
  const out = text
    .replace(URL_WITH_USER, REDACTED)
    .replace(KEY_AND_LITERAL, (span, key: string, sep: string) => (NOT_CREDENTIALS.has(key.toLowerCase()) ? span : `${key}${sep}'${REDACTED}'`))
    .replace(KEY_AND_VALUE, (_span, lead: string, key: string, value: string) => `${lead}${key}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`);
  return stillFlagged(out) ? REDACTED : out;
}
