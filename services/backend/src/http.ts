// Shared by the api handlers: an error that carries its HTTP status.
// Kamui: upstream's in-process `allow` limiter lived here; it is now the `Limiter` interface in limiter.ts.

/** Thrown by a handler to answer with `status` and `{ error: message }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
