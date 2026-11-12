/** An error the client is told about: a stable code and an HTTP status. Never carries user data. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
