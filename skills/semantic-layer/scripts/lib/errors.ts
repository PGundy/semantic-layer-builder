// An error meant for the person running the CLI: printed without a stack trace.
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
