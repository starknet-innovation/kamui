// Structured logs, one JSON object per line.
//
// The entry type is closed on purpose: there is no field that could hold a token, a `sub`,
// an email, a pepper, a key, a nonce, a signature or a request body, and no free-text field.
// Adding a field here is a privacy decision (DESIGN.md, section 7).
import type { IssuerName } from './jwt';

export type LogEntry = {
  event: 'start' | 'request' | 'internal_error';
  request_id?: string;
  /** HTTP status of the response. */
  status?: number;
  /** 'OK' or an ApiError code. */
  outcome?: string;
  /** Known issuer of a token whose signature verified. Never the raw `iss` string. */
  issuer?: IssuerName;
  /** Position of the token's `aud` in the configured list for that issuer. */
  audience_index?: number;
  key_version?: number;
  duration_ms?: number;
  /** Class name of an unexpected error. Never its message: messages may quote input. */
  error_class?: string;
  port?: number;
};

export type Logger = (entry: LogEntry) => void;

export const stdoutLogger: Logger = (entry) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'pepper', ...entry }));
};
