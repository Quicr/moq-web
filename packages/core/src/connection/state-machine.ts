// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview MOQT Connection and Subscription State Machines
 *
 * Provides state management for MOQT connections and subscriptions.
 * Implements proper state transitions according to the MOQT specification
 * with validation and event emission.
 *
 * @example
 * ```typescript
 * import { ConnectionStateMachine, SubscriptionStateMachine } from 'moqt-core';
 *
 * // Connection state
 * const connection = new ConnectionStateMachine();
 * connection.on('stateChange', (state) => console.log('State:', state));
 * connection.transition('connecting');
 * connection.transition('setup_sent');
 * connection.transition('connected');
 *
 * // Subscription state
 * const subscription = new SubscriptionStateMachine(1);
 * subscription.transition('pending');
 * subscription.transition('active');
 * ```
 */

import { Logger } from '../utils/logger.js';

const log = Logger.create('moqt:core:state');

/**
 * Connection states for a MOQT session
 *
 * @remarks
 * The connection progresses through these states during setup:
 * disconnected → connecting → setup_sent → connected
 *
 * Error and closing states can be entered from most other states.
 */
export type ConnectionState =
  | 'disconnected'      // Initial state, no connection
  | 'connecting'        // WebTransport connection in progress
  | 'setup_sent'        // CLIENT_SETUP sent, waiting for SERVER_SETUP
  | 'connected'         // SESSION established, ready for operations
  | 'closing'           // GOAWAY sent or received, draining
  | 'error';            // Fatal error occurred

/**
 * Subscription states for a MOQT track subscription
 *
 * @remarks
 * Subscriptions progress through:
 * pending → active → (ended | error)
 * or pending → error
 */
export type SubscriptionState =
  | 'pending'           // SUBSCRIBE sent, waiting for SUBSCRIBE_OK
  | 'active'            // Subscription confirmed, receiving objects
  | 'ended'             // SUBSCRIBE_DONE received or UNSUBSCRIBE sent
  | 'error';            // SUBSCRIBE_ERROR received

/**
 * Announcement states for a MOQT track namespace
 */
export type AnnouncementState =
  | 'pending'           // ANNOUNCE sent, waiting for ANNOUNCE_OK
  | 'active'            // Announcement confirmed
  | 'ended'             // UNANNOUNCE sent or ANNOUNCE_CANCEL received
  | 'error';            // ANNOUNCE_ERROR received

/**
 * Valid connection state transitions
 */
const connectionTransitions: Record<ConnectionState, ConnectionState[]> = {
  disconnected: ['connecting'],
  connecting: ['setup_sent', 'error', 'disconnected'],
  setup_sent: ['connected', 'error', 'disconnected'],
  connected: ['closing', 'error', 'disconnected'],
  closing: ['disconnected', 'error'],
  error: ['disconnected'],
};

/**
 * Valid subscription state transitions
 */
const subscriptionTransitions: Record<SubscriptionState, SubscriptionState[]> = {
  pending: ['active', 'error', 'ended'],
  active: ['ended', 'error'],
  ended: [],
  error: [],
};

/**
 * Valid announcement state transitions
 */
const announcementTransitions: Record<AnnouncementState, AnnouncementState[]> = {
  pending: ['active', 'error', 'ended'],
  active: ['ended', 'error'],
  ended: [],
  error: [],
};

/**
 * Event handler type for state changes
 */
export type StateChangeHandler<T extends string> = (
  newState: T,
  previousState: T,
  reason?: string
) => void;

/**
 * Base state machine with event emission
 *
 * @typeParam T - Union type of valid states
 */
abstract class StateMachine<T extends string> {
  protected _state: T;
  private handlers: StateChangeHandler<T>[] = [];
  private readonly transitions: Record<T, T[]>;
  private readonly logContext: string;

  /**
   * Create a new state machine
   *
   * @param initialState - Starting state
   * @param transitions - Valid state transition map
   * @param logContext - Context string for logging
   */
  constructor(
    initialState: T,
    transitions: Record<T, T[]>,
    logContext: string
  ) {
    this._state = initialState;
    this.transitions = transitions;
    this.logContext = logContext;
  }

  /**
   * Get the current state
   */
  get state(): T {
    return this._state;
  }

  /**
   * Check if a transition to the target state is valid
   *
   * @param targetState - State to transition to
   * @returns True if the transition is allowed
   */
  canTransition(targetState: T): boolean {
    const allowed = this.transitions[this._state];
    return allowed?.includes(targetState) ?? false;
  }

  /**
   * Attempt to transition to a new state
   *
   * @param targetState - State to transition to
   * @param reason - Optional reason for the transition
   * @returns True if the transition succeeded
   * @throws Never throws - returns false on invalid transition
   *
   * @example
   * ```typescript
   * if (machine.transition('connected')) {
   *   console.log('Now connected');
   * } else {
   *   console.log('Invalid transition');
   * }
   * ```
   */
  transition(targetState: T, reason?: string): boolean {
    if (!this.canTransition(targetState)) {
      log.warn(`${this.logContext}: Invalid transition`, {
        from: this._state,
        to: targetState,
        allowed: this.transitions[this._state],
      });
      return false;
    }

    const previousState = this._state;
    this._state = targetState;

    log.debug(`${this.logContext}: State transition`, {
      from: previousState,
      to: targetState,
      reason,
    });

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(targetState, previousState, reason);
      } catch (err) {
        log.error(`${this.logContext}: State change handler error`, err as Error);
      }
    }

    return true;
  }

  /**
   * Force a state without validation (use with caution)
   *
   * @param state - State to set
   * @param reason - Reason for forcing state
   */
  forceState(state: T, reason?: string): void {
    const previousState = this._state;
    this._state = state;

    log.warn(`${this.logContext}: Forced state`, {
      from: previousState,
      to: state,
      reason,
    });

    for (const handler of this.handlers) {
      try {
        handler(state, previousState, reason);
      } catch (err) {
        log.error(`${this.logContext}: State change handler error`, err as Error);
      }
    }
  }

  /**
   * Register a state change handler
   *
   * @param handler - Function to call on state changes
   * @returns Unsubscribe function
   */
  on(handler: StateChangeHandler<T>): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  /**
   * Remove all handlers
   */
  removeAllHandlers(): void {
    this.handlers = [];
  }

  /**
   * Check if in a specific state
   *
   * @param state - State to check
   */
  isIn(state: T): boolean {
    return this._state === state;
  }

  /**
   * Check if in any of the specified states
   *
   * @param states - States to check
   */
  isInAny(...states: T[]): boolean {
    return states.includes(this._state);
  }
}

/**
 * Connection state machine for MOQT sessions
 *
 * @remarks
 * Manages the lifecycle of a MOQT connection from initial
 * WebTransport setup through session establishment and teardown.
 *
 * @example
 * ```typescript
 * const connection = new ConnectionStateMachine();
 *
 * // Listen for state changes
 * connection.on((newState, oldState, reason) => {
 *   console.log(`Connection: ${oldState} -> ${newState}`);
 *   if (reason) console.log(`Reason: ${reason}`);
 * });
 *
 * // Progress through states
 * connection.transition('connecting');
 * // ... WebTransport connected ...
 * connection.transition('setup_sent');
 * // ... SERVER_SETUP received ...
 * connection.transition('connected');
 * ```
 */
export class ConnectionStateMachine extends StateMachine<ConnectionState> {
  /** Timestamp when connection was established */
  private _connectedAt?: number;
  /** Error that caused transition to error state */
  private _lastError?: Error;

  /**
   * Create a new connection state machine
   */
  constructor() {
    super('disconnected', connectionTransitions, 'Connection');
  }

  /**
   * Get timestamp when connection was established
   */
  get connectedAt(): number | undefined {
    return this._connectedAt;
  }

  /**
   * Get the last error that occurred
   */
  get lastError(): Error | undefined {
    return this._lastError;
  }

  /**
   * Check if the connection is currently usable
   */
  get isUsable(): boolean {
    return this._state === 'connected';
  }

  /**
   * Transition to connecting state
   *
   * @returns True if transition succeeded
   */
  startConnecting(): boolean {
    return this.transition('connecting');
  }

  /**
   * Transition to setup_sent state
   *
   * @returns True if transition succeeded
   */
  setupSent(): boolean {
    return this.transition('setup_sent');
  }

  /**
   * Transition to connected state
   *
   * @returns True if transition succeeded
   */
  setConnected(): boolean {
    const success = this.transition('connected');
    if (success) {
      this._connectedAt = Date.now();
    }
    return success;
  }

  /**
   * Transition to closing state
   *
   * @param reason - Reason for closing
   * @returns True if transition succeeded
   */
  startClosing(reason?: string): boolean {
    return this.transition('closing', reason);
  }

  /**
   * Transition to error state
   *
   * @param error - The error that occurred
   * @returns True if transition succeeded
   */
  setError(error: Error): boolean {
    this._lastError = error;
    return this.transition('error', error.message);
  }

  /**
   * Transition to disconnected state
   *
   * @param reason - Reason for disconnection
   * @returns True if transition succeeded
   */
  setDisconnected(reason?: string): boolean {
    const success = this.transition('disconnected', reason);
    if (success) {
      this._connectedAt = undefined;
      this._lastError = undefined;
    }
    return success;
  }

  /**
   * Reset the state machine
   */
  reset(): void {
    this._connectedAt = undefined;
    this._lastError = undefined;
    this.forceState('disconnected', 'reset');
  }
}

/**
 * Subscription state machine for MOQT track subscriptions
 *
 * @remarks
 * Tracks the state of an individual subscription from request
 * through active data reception to completion or error.
 *
 * @example
 * ```typescript
 * const subscription = new SubscriptionStateMachine(1);
 *
 * subscription.on((newState, oldState, reason) => {
 *   if (newState === 'active') {
 *     console.log('Subscription is now active');
 *   }
 * });
 *
 * subscription.setActive();  // SUBSCRIBE_OK received
 * // ... receive objects ...
 * subscription.setEnded('Track finished');  // SUBSCRIBE_DONE received
 * ```
 */
export class SubscriptionStateMachine extends StateMachine<SubscriptionState> {
  /** Unique subscription identifier */
  readonly subscribeId: number;
  /** Track alias assigned by publisher */
  private _trackAlias?: number;
  /** Error code if subscription failed */
  private _errorCode?: number;
  /** Error reason phrase */
  private _errorReason?: string;
  /** Group ordering preference */
  private _groupOrder?: number;
  /** Timestamp when subscription became active */
  private _activeAt?: number;

  /**
   * Create a new subscription state machine
   *
   * @param subscribeId - Unique subscription identifier
   */
  constructor(subscribeId: number) {
    super('pending', subscriptionTransitions, `Subscription[${subscribeId}]`);
    this.subscribeId = subscribeId;
  }

  /**
   * Get the assigned track alias
   */
  get trackAlias(): number | undefined {
    return this._trackAlias;
  }

  /**
   * Get the error code if subscription failed
   */
  get errorCode(): number | undefined {
    return this._errorCode;
  }

  /**
   * Get the error reason if subscription failed
   */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /**
   * Get the group ordering preference
   */
  get groupOrder(): number | undefined {
    return this._groupOrder;
  }

  /**
   * Get timestamp when subscription became active
   */
  get activeAt(): number | undefined {
    return this._activeAt;
  }

  /**
   * Check if subscription is receiving data
   */
  get isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * Check if subscription has ended (successfully or with error)
   */
  get hasEnded(): boolean {
    return this._state === 'ended' || this._state === 'error';
  }

  /**
   * Set subscription as active (SUBSCRIBE_OK received)
   *
   * @param trackAlias - Track alias from SUBSCRIBE_OK
   * @param groupOrder - Group ordering from SUBSCRIBE_OK
   * @returns True if transition succeeded
   */
  setActive(trackAlias?: number, groupOrder?: number): boolean {
    const success = this.transition('active');
    if (success) {
      this._trackAlias = trackAlias;
      this._groupOrder = groupOrder;
      this._activeAt = Date.now();
    }
    return success;
  }

  /**
   * Set subscription as ended
   *
   * @param reason - Reason for ending
   * @returns True if transition succeeded
   */
  setEnded(reason?: string): boolean {
    return this.transition('ended', reason);
  }

  /**
   * Set subscription as errored (SUBSCRIBE_ERROR received)
   *
   * @param errorCode - Error code from SUBSCRIBE_ERROR
   * @param reason - Error reason phrase
   * @returns True if transition succeeded
   */
  setError(errorCode: number, reason: string): boolean {
    this._errorCode = errorCode;
    this._errorReason = reason;
    return this.transition('error', reason);
  }
}

/**
 * Announcement state machine for MOQT track announcements
 *
 * @remarks
 * Tracks the state of a track namespace announcement from
 * request through confirmation to cancellation.
 *
 * @example
 * ```typescript
 * const announcement = new AnnouncementStateMachine(['app', 'room1', 'media']);
 *
 * announcement.setActive();  // ANNOUNCE_OK received
 * // ... track is available ...
 * announcement.setEnded('Leaving room');  // UNANNOUNCE sent
 * ```
 */
export class AnnouncementStateMachine extends StateMachine<AnnouncementState> {
  /** Announced namespace */
  readonly namespace: string[];
  /** Error code if announcement failed */
  private _errorCode?: number;
  /** Error reason phrase */
  private _errorReason?: string;
  /** Timestamp when announcement became active */
  private _activeAt?: number;

  /**
   * Create a new announcement state machine
   *
   * @param namespace - Track namespace being announced
   */
  constructor(namespace: string[]) {
    super('pending', announcementTransitions, `Announcement[${namespace.join('/')}]`);
    this.namespace = namespace;
  }

  /**
   * Get the error code if announcement failed
   */
  get errorCode(): number | undefined {
    return this._errorCode;
  }

  /**
   * Get the error reason if announcement failed
   */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /**
   * Get timestamp when announcement became active
   */
  get activeAt(): number | undefined {
    return this._activeAt;
  }

  /**
   * Check if announcement is active
   */
  get isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * Check if announcement has ended
   */
  get hasEnded(): boolean {
    return this._state === 'ended' || this._state === 'error';
  }

  /**
   * Set announcement as active (ANNOUNCE_OK received)
   *
   * @returns True if transition succeeded
   */
  setActive(): boolean {
    const success = this.transition('active');
    if (success) {
      this._activeAt = Date.now();
    }
    return success;
  }

  /**
   * Set announcement as ended
   *
   * @param reason - Reason for ending
   * @returns True if transition succeeded
   */
  setEnded(reason?: string): boolean {
    return this.transition('ended', reason);
  }

  /**
   * Set announcement as errored (ANNOUNCE_ERROR received)
   *
   * @param errorCode - Error code from ANNOUNCE_ERROR
   * @param reason - Error reason phrase
   * @returns True if transition succeeded
   */
  setError(errorCode: number, reason: string): boolean {
    this._errorCode = errorCode;
    this._errorReason = reason;
    return this.transition('error', reason);
  }
}

/**
 * Namespace subscription state machine
 *
 * @remarks
 * Tracks subscriptions to track namespaces for discovery purposes.
 */
export class NamespaceSubscriptionStateMachine extends StateMachine<SubscriptionState> {
  /** Namespace prefix being subscribed to */
  readonly namespacePrefix: string[];
  /** Error code if subscription failed */
  private _errorCode?: number;
  /** Error reason phrase */
  private _errorReason?: string;

  /**
   * Create a new namespace subscription state machine
   *
   * @param namespacePrefix - Namespace prefix to subscribe to
   */
  constructor(namespacePrefix: string[]) {
    super('pending', subscriptionTransitions, `NsSubscription[${namespacePrefix.join('/')}]`);
    this.namespacePrefix = namespacePrefix;
  }

  /**
   * Get the error code if subscription failed
   */
  get errorCode(): number | undefined {
    return this._errorCode;
  }

  /**
   * Get the error reason if subscription failed
   */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /**
   * Check if subscription is active
   */
  get isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * Set subscription as active (SUBSCRIBE_NAMESPACE_OK received)
   *
   * @returns True if transition succeeded
   */
  setActive(): boolean {
    return this.transition('active');
  }

  /**
   * Set subscription as ended
   *
   * @param reason - Reason for ending
   * @returns True if transition succeeded
   */
  setEnded(reason?: string): boolean {
    return this.transition('ended', reason);
  }

  /**
   * Set subscription as errored
   *
   * @param errorCode - Error code
   * @param reason - Error reason phrase
   * @returns True if transition succeeded
   */
  setError(errorCode: number, reason: string): boolean {
    this._errorCode = errorCode;
    this._errorReason = reason;
    return this.transition('error', reason);
  }
}
