/**
 * Staleness checker for top-N video tiles.
 *
 * When the relay stops forwarding a track (because a new speaker displaced
 * it), the subscriber stops receiving frames. The staleness checker detects
 * this gap and marks the participant for removal from display slots.
 *
 * @see quicr-mac/docs/top-n-active-speaker-design.md §4.3
 */

export interface StalenessConfig {
  /** Seconds without a frame before marking as stale (default: 0.3) */
  threshold: number;
  /** Check interval in ms (default: threshold/2 * 1000) */
  intervalMs?: number;
}

const DEFAULT_CONFIG: StalenessConfig = {
  threshold: 0.3,
};

export class StalenessChecker {
  private config: StalenessConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrameTimes = new Map<string, number>();
  private onStale?: (staleIds: string[]) => void;

  constructor(config?: Partial<StalenessConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record that a video frame was received for a participant */
  recordFrame(participantId: string): void {
    this.lastFrameTimes.set(participantId, performance.now() / 1000);
  }

  /** Remove a participant from tracking */
  remove(participantId: string): void {
    this.lastFrameTimes.delete(participantId);
  }

  /** Start periodic staleness checks */
  start(onStale: (staleIds: string[]) => void): void {
    this.onStale = onStale;
    const intervalMs = this.config.intervalMs ?? (this.config.threshold / 2) * 1000;
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  /** Stop checking */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onStale = undefined;
    this.lastFrameTimes.clear();
  }

  private check(): void {
    const now = performance.now() / 1000;
    const displayed = Array.from(this.lastFrameTimes.entries());
    const freshCount = displayed.filter(([, t]) => (now - t) <= this.config.threshold).length;

    // Only mark stale if we have enough fresh participants to replace them
    if (freshCount < 1) return;

    const staleIds: string[] = [];
    for (const [id, lastTime] of displayed) {
      if ((now - lastTime) > this.config.threshold) {
        staleIds.push(id);
      }
    }

    if (staleIds.length > 0 && this.onStale) {
      this.onStale(staleIds);
    }
  }
}
