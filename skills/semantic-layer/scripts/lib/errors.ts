// An error meant for the person running the CLI: printed without a stack trace. `next` is the
// command that fixes it, where there is one; --json output carries it beside the message.
export class UserError extends Error {
  constructor(
    message: string,
    readonly next?: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}
