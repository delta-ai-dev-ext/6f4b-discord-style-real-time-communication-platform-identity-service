import type { PendingOutboxEvent } from '../models/domain';
import type { LoggerPort } from '../observability/logger';
import type {
  EventPublisher,
  OutboxDisposition,
  OutboxMetrics,
  OutboxProcessResult,
  OutboxQueue,
} from '../repositories/ports';

export type OutboxWorkerDeps = {
  queue: OutboxQueue;
  publisher: EventPublisher;
  metrics: OutboxMetrics;
  logger: LoggerPort;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  /** Backoff ceiling for repeated publish failures. */
  maxBackoffMs?: number;
};

export type OutboxWorkerState = 'idle' | 'running' | 'stopping' | 'stopped';

/**
 * Drains `outbox_event` after commit (ADR-002).
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` (see the Drizzle adapter), so
 * every replica can run this worker safely. Failures are retried with
 * exponential backoff up to `OUTBOX_MAX_ATTEMPTS`, after which the row is
 * dead-lettered (attempts + last_error recorded, metric incremented) without
 * ever rolling back the domain state change.
 */
export class OutboxWorker {
  private readonly deps: OutboxWorkerDeps;
  private readonly maxBackoffMs: number;

  private state: OutboxWorkerState = 'idle';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private consecutiveFailures = 0;

  constructor(deps: OutboxWorkerDeps) {
    this.deps = deps;
    this.maxBackoffMs = deps.maxBackoffMs ?? 5_000;
  }

  getState(): OutboxWorkerState {
    return this.state;
  }

  /** Connects the producer and starts the polling loop. */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    await this.deps.publisher.connect();
    this.state = 'running';
    this.deps.logger.info('outbox worker started', {
      poll_interval_ms: this.deps.pollIntervalMs,
      batch_size: this.deps.batchSize,
    });
    this.schedule(() => {
      void this.tick();
    });
  }

  /**
   * One claimed batch. Exposed for tests and for the shutdown drain window.
   */
  async drainOnce(): Promise<OutboxProcessResult> {
    const result = await this.deps.queue.claimAndProcess(
      this.deps.batchSize,
      (event) => this.publishOne(event),
    );

    try {
      const pending = await this.deps.queue.countPending(this.deps.publisher.topic);
      this.deps.metrics.setOutboxPending(this.deps.publisher.topic, pending);
    } catch (error) {
      this.deps.logger.warn('outbox pending gauge refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }

  /** Stops polling and lets an in-flight batch finish (graceful shutdown). */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight !== undefined) {
      await this.inFlight.catch(() => undefined);
    }
    this.state = 'stopped';
    this.deps.logger.info('outbox worker stopped');
  }

  private async publishOne(event: PendingOutboxEvent): Promise<OutboxDisposition> {
    const attempt = event.attempts + 1;

    if (attempt > this.deps.maxAttempts) {
      this.deps.metrics.recordDeadLettered(event.topic);
      this.deps.logger.error('outbox event dead-lettered', {
        event_type: event.eventType,
        attempts: event.attempts,
      });
      return {
        kind: 'dead_letter',
        error: `retry budget exhausted after ${event.attempts} attempts`,
      };
    }

    try {
      await this.deps.publisher.publish(event);
      return { kind: 'published' };
    } catch (error) {
      this.deps.metrics.recordProduceError(event.topic);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn('outbox publish failed, retry scheduled', {
        event_type: event.eventType,
        attempt,
        error: message,
      });
      return { kind: 'retry', error: message };
    }
  }

  private schedule(run: () => void): void {
    this.timer = setTimeout(run, this.nextDelay());
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.state !== 'running') return;

    this.inFlight = (async () => {
      try {
        const result = await this.drainOnce();
        this.consecutiveFailures =
          result.retried > 0 || result.deadLettered > 0 ? this.consecutiveFailures + 1 : 0;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.deps.logger.error('outbox batch failed', {
          error: error instanceof Error ? error.message : String(error),
          consecutive_failures: this.consecutiveFailures,
        });
      }
    })();

    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
      if (this.state === 'running') {
        this.schedule(() => {
          void this.tick();
        });
      }
    }
  }

  /** Exponential backoff: poll interval doubled per consecutive failure. */
  private nextDelay(): number {
    if (this.consecutiveFailures === 0) return this.deps.pollIntervalMs;
    const factor = 2 ** Math.min(this.consecutiveFailures, 16);
    return Math.min(this.deps.pollIntervalMs * factor, this.maxBackoffMs);
  }
}
