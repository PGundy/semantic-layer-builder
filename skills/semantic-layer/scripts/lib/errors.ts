// An error meant for the person running the CLI: printed without a stack trace. `next` is the
// command that fixes it, where there is one; `code` is the stable word an agent branches on. With
// --json a refusal is also one object on stdout, {error, code, next?} (lib/cli.ts).
export class UserError extends Error {
  constructor(
    message: string,
    readonly next?: string,
    // A bare word (user_error, no_layer) for a refusal that is not a validate issue, or a code
    // registered in lib/issue-codes/ (family.name) for one that is the refusal of an issue.
    readonly code: string = "user_error",
  ) {
    super(message);
    this.name = "UserError";
  }
}
