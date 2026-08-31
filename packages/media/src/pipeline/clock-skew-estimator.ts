// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Clock Skew Estimator (Octoping-style design)
 *
 * Estimates clock offset between publisher and subscriber using
 * bidirectional timestamp exchange, based on octoping/NTP algorithm.
 *
 * @see https://github.com/private-octopus/octoping
 *
 * Protocol:
 * 1. Publisher sends frame with captureTimestamp (t_send)
 * 2. Subscriber receives frame, records local time (t_server)
 * 3. Subscriber echoes { t_send, t_server } back to publisher
 * 4. Publisher receives echo at t_received, computes:
 *    - RTT = t_received - t_send
 *    - phase = t_server - (t_send + t_received) / 2
 *
 * The phase represents clock offset: subscriber_clock - publisher_clock
 * Uses minimum-RTT filtering to select best samples (less queuing jitter)
 */

const log = {
  debug: (..._args: unknown[]) => {},
  info: (...args: unknown[]) => console.info('[ClockSkew]', ...args),
  warn: (...args: unknown[]) => console.warn('[ClockSkew]', ...args),
};

/**
 * Timing feedback sample from subscriber (echo)
 */
export interface TimingFeedback {
  /** Publisher's original send/capture timestamp */
  sendTime: number;
  /** Subscriber's receive time (their clock) */
  serverTime: number;
}

/**
 * Clock skew estimation result
 */
export interface ClockSkewEstimate {
  /** Estimated clock offset in ms (subscriber - publisher) */
  offsetMs: number;
  /** Minimum observed RTT in ms */
  minRttMs: number;
  /** Current RTT in ms */
  currentRttMs: number;
  /** Number of samples processed */
  sampleCount: number;
  /** Whether estimate is considered stable */
  isStable: boolean;
}

/**
 * Configuration for ClockSkewEstimator
 */
export interface ClockSkewEstimatorConfig {
  /** RTT threshold factor - samples with RTT > minRTT * factor are rejected (default: 1.5) */
  rttThresholdFactor?: number;
  /** Smoothing factor for EWMA (0-1, default: 0.1 for stability) */
  smoothingFactor?: number;
  /** Maximum valid RTT in ms (default: 5000) */
  maxRttMs?: number;
  /** Minimum samples for stable estimate (default: 5) */
  minSamplesForStable?: number;
  /** Initial minimum RTT seed in ms (default: Infinity) */
  initialMinRtt?: number;
}

/**
 * Estimates clock skew using octoping-style algorithm
 *
 * Key features:
 * - Uses NTP midpoint formula: phase = t_server - (t_send + t_received) / 2
 * - Minimum RTT filtering: only low-jitter samples update the estimate
 * - Exponential smoothing (EWMA) for stability
 * - Sanity checks for negative one-way delays
 *
 * @example
 * ```typescript
 * const estimator = new ClockSkewEstimator();
 *
 * // When feedback arrives from subscriber
 * estimator.addFeedback({ sendTime: t1, serverTime: t2 }, Date.now());
 *
 * // Get offset to embed in LOC header
 * const offset = estimator.getClockOffset();
 * ```
 */
export class ClockSkewEstimator {
  private config: Required<ClockSkewEstimatorConfig>;
  private minRtt = Infinity;
  private currentPhase = 0;
  private sampleCount = 0;
  private lastRtt = 0;
  private hasInitialEstimate = false;

  constructor(config: ClockSkewEstimatorConfig = {}) {
    this.config = {
      rttThresholdFactor: config.rttThresholdFactor ?? 1.5,
      smoothingFactor: config.smoothingFactor ?? 0.1,
      maxRttMs: config.maxRttMs ?? 5000,
      minSamplesForStable: config.minSamplesForStable ?? 5,
      initialMinRtt: config.initialMinRtt ?? Infinity,
    };
    this.minRtt = this.config.initialMinRtt;
  }

  /**
   * Process timing feedback (echo) from subscriber
   *
   * @param feedback - Contains sendTime (publisher) and serverTime (subscriber)
   * @param receiveTime - When publisher received this feedback
   */
  addFeedback(feedback: TimingFeedback, receiveTime: number): void {
    const { sendTime, serverTime } = feedback;

    // Compute RTT
    const rtt = receiveTime - sendTime;

    // Reject invalid RTT
    if (rtt < 0 || rtt > this.config.maxRttMs) {
      log.warn('Rejecting invalid RTT', { rtt, sendTime, serverTime, receiveTime });
      return;
    }

    this.lastRtt = rtt;
    this.sampleCount++;

    // Update minimum RTT
    if (rtt < this.minRtt) {
      this.minRtt = rtt;
      log.debug('New minimum RTT', { minRtt: this.minRtt });
    }

    // Octoping-style phase calculation (NTP midpoint formula)
    // phase = server_time - midpoint(send, receive)
    const midpoint = (sendTime + receiveTime) / 2;
    const phase = serverTime - midpoint;

    // Sanity check: one-way delays should be non-negative
    // up_delay = serverTime - sendTime - phase = midpoint - sendTime = rtt/2
    // down_delay = receiveTime - serverTime + phase = receiveTime - midpoint = rtt/2
    // These are always rtt/2 by construction, so no sanity check needed for midpoint formula

    // Minimum RTT filtering: only update if RTT is close to minimum
    // This rejects samples with queuing delay or asymmetric paths
    const rttThreshold = this.minRtt * this.config.rttThresholdFactor;

    if (rtt <= rttThreshold || !this.hasInitialEstimate) {
      // Update phase estimate using EWMA
      if (!this.hasInitialEstimate) {
        this.currentPhase = phase;
        this.hasInitialEstimate = true;
        log.info('Initial phase estimate', { phase: Math.round(phase), rtt });
      } else {
        const alpha = this.config.smoothingFactor;
        this.currentPhase = (1 - alpha) * this.currentPhase + alpha * phase;
        log.debug('Updated phase', {
          phase: Math.round(this.currentPhase),
          sample: Math.round(phase),
          rtt,
          minRtt: Math.round(this.minRtt),
        });
      }
    } else {
      log.debug('Skipping high-RTT sample', { rtt, threshold: rttThreshold });
    }
  }

  /**
   * Get current clock offset estimate in milliseconds
   *
   * @returns Clock offset (subscriber_clock - publisher_clock)
   *
   * To correct raw E2E on subscriber:
   *   correctedE2E = rawE2E - clockOffset
   *
   * If subscriber clock is ahead by 50ms, rawE2E will be 50ms too high.
   * Subtracting the offset corrects this.
   */
  getClockOffset(): number {
    return Math.round(this.currentPhase);
  }

  /**
   * Get minimum observed RTT in milliseconds
   */
  getMinRtt(): number {
    return this.minRtt === Infinity ? 0 : Math.round(this.minRtt);
  }

  /**
   * Get current RTT in milliseconds
   */
  getCurrentRtt(): number {
    return Math.round(this.lastRtt);
  }

  /**
   * Check if estimate is stable (enough low-RTT samples)
   */
  isStable(): boolean {
    return this.sampleCount >= this.config.minSamplesForStable && this.hasInitialEstimate;
  }

  /**
   * Get full estimation state
   */
  getEstimate(): ClockSkewEstimate {
    return {
      offsetMs: this.getClockOffset(),
      minRttMs: this.getMinRtt(),
      currentRttMs: this.getCurrentRtt(),
      sampleCount: this.sampleCount,
      isStable: this.isStable(),
    };
  }

  /**
   * Reset the estimator
   */
  reset(): void {
    this.minRtt = this.config.initialMinRtt;
    this.currentPhase = 0;
    this.sampleCount = 0;
    this.lastRtt = 0;
    this.hasInitialEstimate = false;
  }
}

/**
 * Create timing feedback to echo from subscriber to publisher
 *
 * @param captureTimestamp - Original capture timestamp from received frame
 * @param receiveTime - When subscriber received the frame (Date.now())
 * @returns Feedback to send back to publisher
 */
export function createTimingFeedback(
  captureTimestamp: number,
  receiveTime: number
): TimingFeedback {
  return {
    sendTime: captureTimestamp,
    serverTime: receiveTime,
  };
}

/**
 * Serialize timing feedback for transmission (16 bytes)
 */
export function serializeTimingFeedback(feedback: TimingFeedback): Uint8Array {
  const buffer = new ArrayBuffer(16); // 2 x float64
  const view = new DataView(buffer);
  view.setFloat64(0, feedback.sendTime, false); // big-endian
  view.setFloat64(8, feedback.serverTime, false);
  return new Uint8Array(buffer);
}

/**
 * Deserialize timing feedback from transmission
 */
export function deserializeTimingFeedback(data: Uint8Array): TimingFeedback {
  if (data.byteLength < 16) {
    throw new Error(`Invalid timing feedback size: ${data.byteLength}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    sendTime: view.getFloat64(0, false),
    serverTime: view.getFloat64(8, false),
  };
}
