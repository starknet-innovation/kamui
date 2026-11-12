// Kamui: structured logs. One JSON object per line: { ts, level, event, ...fields }.
//
// What may be logged: event names, error codes, transaction hashes, block numbers, key ids,
// budget names, durations, and account addresses on the recovery and sponsor routes (they are
// public on chain next to the transaction hash already logged, and a stuck recovery cannot be
// debugged without them). What is never logged: tokens, peppers, keys, signatures, proofs, user
// ids (`sub`, email), request bodies, client addresses, origins, and anything from the session
// registry that names an account. Fields whose name looks like one of those are replaced, as a
// second line of defence; the first is not passing them.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const FORBIDDEN = /jwt|token|pepper|signature|secret|private|proof$|^body$|^sub$|email|origin|^ip$|client_ip|calldata/i;

let sink: (line: string, level: LogLevel) => void = (line, level) => (level === 'error' || level === 'warn' ? console.error(line) : console.log(line));

/** Tests replace the sink to read what was logged. Returns the previous one. */
export function setLogSink(next: typeof sink): typeof sink {
  const previous = sink;
  sink = next;
  return previous;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    entry[name] = FORBIDDEN.test(name) ? '[redacted]' : typeof value === 'string' ? value.slice(0, 300) : value;
  }
  sink(JSON.stringify(entry), level);
}

/**
 * What an error may contribute to a log line or a metric: its code when the message is one of
 * ours (`WRONG_CLASS`, `REVERTED: ...` keeps only `REVERTED`), otherwise the error's class name.
 * Free-form messages are not logged: an RPC error echoes the request, a JSON error echoes input.
 */
export function errorCode(e: unknown): string {
  const message = e instanceof Error ? e.message : '';
  const code = /^[A-Z][A-Z0-9_]{2,40}(?=$|:)/.exec(message)?.[0];
  return code ?? (e instanceof Error ? e.constructor.name : 'UNKNOWN');
}
