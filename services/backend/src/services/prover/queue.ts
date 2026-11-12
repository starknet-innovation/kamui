// Kamui: the prover works on one proof at a time and needs up to about 20 GB for it (see
// compose.yml). This gate keeps the api from sending it more: `concurrency` proofs run, at most
// `maxQueued` wait, and a request that finds the queue full, or waits longer than `maxWaitMs`,
// is refused with 503 PROVER_BUSY. In process: with several api replicas in front of one prover,
// divide the limits between them or put the gate in front of the prover.
import { HttpError } from '../../http';
import { metrics } from '../../metrics';

export type ProofQueueOptions = { concurrency?: number; maxQueued?: number; maxWaitMs?: number };

export class ProofQueue {
  private running = 0;
  private waiting: { start: () => void; cancel: (e: Error) => void }[] = [];
  readonly concurrency: number;
  readonly maxQueued: number;
  readonly maxWaitMs: number;

  constructor(options: ProofQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.maxQueued = Math.max(0, options.maxQueued ?? 4);
    this.maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  }

  /** True when a new proof request would be refused right now. Check before paying for anything else. */
  get full(): boolean {
    return this.running >= this.concurrency && this.waiting.length >= this.maxQueued;
  }

  get depth(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  /** Runs `work` when a slot is free. Throws 503 PROVER_BUSY when the queue is full or the wait is too long. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxQueued) {
        metrics.proofs.inc({ result: 'refused' });
        throw new HttpError(503, 'PROVER_BUSY');
      }
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: () => {
            clearTimeout(timer);
            resolve();
          },
          cancel: reject,
        };
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== entry);
          this.report();
          metrics.proofs.inc({ result: 'refused' });
          reject(new HttpError(503, 'PROVER_BUSY'));
        }, this.maxWaitMs);
        this.waiting.push(entry);
        this.report();
      });
    } else {
      this.running += 1;
    }
    this.report();
    try {
      return await work();
    } finally {
      // Hand the slot straight to the next in line, so `running` never dips and nobody jumps the queue.
      const next = this.waiting.shift();
      if (next) next.start();
      else this.running -= 1;
      this.report();
    }
  }

  private report(): void {
    metrics.proofsRunning.set(this.running);
    metrics.proofsWaiting.set(this.waiting.length);
  }
}
