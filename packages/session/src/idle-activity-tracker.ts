// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Draft-18 §13.6.1 idle-timeout / §11.5 keepalive tracker.
 *
 * Extracted from `session.ts` to keep the session file focused on protocol
 * state machine work. The tracker owns:
 *   - Configuration (idle timeout / keepalive interval).
 *   - Sliding activity timestamps.
 *   - A recurring poll that decides whether to send a padding datagram
 *     (keepalive) or close the session (idle timeout).
 *
 * The tracker calls back into the session for the two side effects it can't
 * perform locally — sending a padding datagram and closing the session — and
 * uses an `isReady()` predicate so it never fires while the session is not
 * in the `ready` state.
 */

/** Configuration values kept live by the tracker. */
export interface IdleActivityConfig {
  /** Close the session after this much inactivity in either direction. 0 / undefined disables. */
  idleTimeoutMs?: number;
  /** Send a §11.5 padding datagram after this much outbound silence. 0 / undefined disables. */
  keepaliveIntervalMs?: number;
}

/** Collaborators the tracker calls back into. */
export interface IdleActivityCallbacks {
  /** True while the session is in `ready`; the tracker no-ops otherwise. */
  isReady(): boolean;
  /**
   * Send a padding datagram of `bytes` length. Fire-and-forget from the
   * tracker's perspective; the callee is responsible for `markOutbound()`.
   */
  sendPaddingDatagram(bytes: number): Promise<void>;
  /**
   * Fired when the tracker decides the session has been idle for
   * `idleTimeoutMs`. The session is responsible for the actual close +
   * event emission.
   */
  onIdleTimeout(sinceMs: number): void;
  /** Warning-level log sink for keepalive send failures. */
  logWarn?(msg: string, err: unknown): void;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class IdleActivityTracker {
  private config: IdleActivityConfig = {};
  private timer?: ReturnType<typeof setInterval>;
  private lastOutboundMs = 0;
  private lastInboundMs = 0;
  private closePending = false;

  constructor(private readonly cb: IdleActivityCallbacks) {}

  /** Replace configuration. Callers pass raw values; zeros are normalized to undefined. */
  configure(config: IdleActivityConfig): void {
    this.config = {
      idleTimeoutMs: config.idleTimeoutMs && config.idleTimeoutMs > 0 ? config.idleTimeoutMs : undefined,
      keepaliveIntervalMs: config.keepaliveIntervalMs && config.keepaliveIntervalMs > 0
        ? config.keepaliveIntervalMs
        : undefined,
    };
  }

  /** Baseline both activity timestamps to `now`. Used on live reconfigure. */
  resetActivityBaseline(): void {
    const now = nowMs();
    this.lastOutboundMs = now;
    this.lastInboundMs = now;
  }

  /** Called on every outbound control / datagram send. */
  markOutbound(): void {
    if (this.config.idleTimeoutMs || this.config.keepaliveIntervalMs) {
      this.lastOutboundMs = nowMs();
    }
  }

  /** Called on every inbound control / stream / datagram byte. */
  markInbound(): void {
    if (this.config.idleTimeoutMs || this.config.keepaliveIntervalMs) {
      this.lastInboundMs = nowMs();
    }
  }

  /** Arm the polling timer. No-op if already running or if no threshold is configured. */
  start(): void {
    if (this.timer !== undefined) return;
    const { idleTimeoutMs, keepaliveIntervalMs } = this.config;
    if (!idleTimeoutMs && !keepaliveIntervalMs) return;
    // Poll at a granularity that catches the tightest threshold reasonably
    // fast without polling too aggressively.
    const tick = Math.max(50, Math.min(idleTimeoutMs ?? Infinity, keepaliveIntervalMs ?? Infinity) / 4);
    const started = nowMs();
    if (this.lastOutboundMs === 0) this.lastOutboundMs = started;
    if (this.lastInboundMs === 0) this.lastInboundMs = started;
    this.timer = setInterval(() => { this.onTick(); }, tick);
  }

  /** Disarm the polling timer. Idempotent. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private onTick(): void {
    if (!this.cb.isReady()) return;
    const now = nowMs();
    const { idleTimeoutMs, keepaliveIntervalMs } = this.config;

    if (keepaliveIntervalMs && !this.closePending) {
      const sinceOutbound = now - this.lastOutboundMs;
      if (sinceOutbound >= keepaliveIntervalMs) {
        this.cb.sendPaddingDatagram(1).catch((err: unknown) => {
          this.cb.logWarn?.('Idle keepalive padding datagram failed', err);
        });
      }
    }

    if (idleTimeoutMs && !this.closePending) {
      const sinceActivity = Math.min(
        now - this.lastOutboundMs,
        now - this.lastInboundMs,
      );
      if (sinceActivity >= idleTimeoutMs) {
        this.closePending = true;
        this.cb.onIdleTimeout(Math.round(sinceActivity));
      }
    }
  }
}
