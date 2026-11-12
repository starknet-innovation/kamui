// Kamui: counters, gauges and histograms in the Prometheus text format, in process. Each replica
// reports its own numbers; the scraper adds them up. Label values only ever come from fixed sets
// in the code or from configuration (route names, outcomes, budget names, issuers): never from
// a request, so no label can carry an account, a user id, a client address or a token.
type Labels = Record<string, string>;

const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const render = (labels: Labels) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

abstract class Metric {
  constructor(readonly name: string, readonly help: string, readonly type: string) {}
  abstract lines(): string[];
  abstract reset(): void;
}

export class Counter extends Metric {
  private values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, by = 1): void {
    const key = render(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(render(labels)) ?? 0;
  }
  lines(): string[] {
    return [...this.values].map(([labels, value]) => `${this.name}${labels} ${value}`);
  }
  reset(): void {
    this.values.clear();
  }
}

export class Gauge extends Metric {
  private value = 0;
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(value: number): void {
    this.value = value;
  }
  lines(): string[] {
    return [`${this.name} ${this.value}`];
  }
  reset(): void {
    this.value = 0;
  }
}

export class Histogram extends Metric {
  private counts: number[];
  private sum = 0;
  private count = 0;
  constructor(name: string, help: string, private buckets: number[]) {
    super(name, help, 'histogram');
    this.counts = buckets.map(() => 0);
  }
  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    this.buckets.forEach((le, i) => {
      if (value <= le) this.counts[i]! += 1;
    });
  }
  lines(): string[] {
    return [
      ...this.buckets.map((le, i) => `${this.name}_bucket{le="${le}"} ${this.counts[i]}`),
      `${this.name}_bucket{le="+Inf"} ${this.count}`,
      `${this.name}_sum ${this.sum}`,
      `${this.name}_count ${this.count}`,
    ];
  }
  reset(): void {
    this.counts = this.buckets.map(() => 0);
    this.sum = 0;
    this.count = 0;
  }
}

export const metrics = {
  /** outcome: ok, rejected (4xx), rate_limited (429), failed (5xx). */
  requests: new Counter('kamui_http_requests_total', 'Requests by route and outcome.'),
  /** scope: client, global. */
  rateLimited: new Counter('kamui_rate_limited_total', 'Requests refused by a rate limit, by route and scope.'),
  /** result: accepted, succeeded, failed, refused (job store full). No IDs or accounts. */
  recoveryJobs: new Counter('kamui_recovery_jobs_total', 'Recovery jobs by result.'),
  /** result: started, succeeded, failed, refused (queue full or waited too long). */
  proofs: new Counter('kamui_proofs_total', 'Backend proofs by result.'),
  proofSeconds: new Histogram('kamui_proof_duration_seconds', 'Time the prover took for one proof.', [5, 15, 30, 60, 120, 300, 600]),
  proofsWaiting: new Gauge('kamui_proofs_waiting', 'Proof requests waiting for the prover.'),
  proofsRunning: new Gauge('kamui_proofs_running', 'Proofs the prover is working on.'),
  /** decision: sponsored, refused_budget, refused_account_budget, refused_fee, reverted, disabled, unknown_app, failed. */
  sponsor: new Counter('kamui_sponsor_decisions_total', 'Sponsor decisions by budget and decision.'),
  /** target: jwks, pepper, prover, rpc. */
  outboundFailures: new Counter('kamui_outbound_failures_total', 'Failed calls to a service this backend depends on, by target.'),
  jwksFetches: new Counter('kamui_jwks_fetches_total', 'Issuer key fetches by issuer and result.'),
  relayerTransactions: new Counter('kamui_relayer_transactions_total', 'Transactions the relayer submitted, by kind.'),
  registryWrites: new Counter('kamui_registry_requests_total', 'Session registry requests by action and result.'),
};

/** The whole registry as Prometheus text (version 0.0.4). */
export function renderMetrics(): string {
  const out: string[] = [];
  for (const metric of Object.values(metrics)) {
    out.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.lines());
  }
  return out.join('\n') + '\n';
}

/** For tests. */
export function resetMetrics(): void {
  for (const metric of Object.values(metrics)) metric.reset();
}
