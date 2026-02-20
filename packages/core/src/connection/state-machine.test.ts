// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview State Machine Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConnectionStateMachine,
  SubscriptionStateMachine,
  AnnouncementStateMachine,
  NamespaceSubscriptionStateMachine,
} from './state-machine';

describe('ConnectionStateMachine', () => {
  let machine: ConnectionStateMachine;

  beforeEach(() => {
    machine = new ConnectionStateMachine();
  });

  describe('initial state', () => {
    it('starts in disconnected state', () => {
      expect(machine.state).toBe('disconnected');
    });

    it('is not usable initially', () => {
      expect(machine.isUsable).toBe(false);
    });

    it('has no connectedAt timestamp initially', () => {
      expect(machine.connectedAt).toBeUndefined();
    });

    it('has no lastError initially', () => {
      expect(machine.lastError).toBeUndefined();
    });
  });

  describe('valid transitions', () => {
    it('transitions from disconnected to connecting', () => {
      expect(machine.startConnecting()).toBe(true);
      expect(machine.state).toBe('connecting');
    });

    it('transitions from connecting to setup_sent', () => {
      machine.startConnecting();
      expect(machine.setupSent()).toBe(true);
      expect(machine.state).toBe('setup_sent');
    });

    it('transitions from setup_sent to connected', () => {
      machine.startConnecting();
      machine.setupSent();
      expect(machine.setConnected()).toBe(true);
      expect(machine.state).toBe('connected');
      expect(machine.isUsable).toBe(true);
    });

    it('transitions from connected to closing', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      expect(machine.startClosing('graceful shutdown')).toBe(true);
      expect(machine.state).toBe('closing');
    });

    it('transitions from closing to disconnected', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      machine.startClosing();
      expect(machine.setDisconnected()).toBe(true);
      expect(machine.state).toBe('disconnected');
    });
  });

  describe('error transitions', () => {
    it('transitions from connecting to error', () => {
      machine.startConnecting();
      const error = new Error('Connection failed');
      expect(machine.setError(error)).toBe(true);
      expect(machine.state).toBe('error');
      expect(machine.lastError).toBe(error);
    });

    it('transitions from setup_sent to error', () => {
      machine.startConnecting();
      machine.setupSent();
      const error = new Error('Setup rejected');
      expect(machine.setError(error)).toBe(true);
      expect(machine.state).toBe('error');
    });

    it('transitions from connected to error', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      const error = new Error('Connection lost');
      expect(machine.setError(error)).toBe(true);
      expect(machine.state).toBe('error');
    });

    it('transitions from error to disconnected', () => {
      machine.startConnecting();
      machine.setError(new Error('test'));
      expect(machine.setDisconnected()).toBe(true);
      expect(machine.state).toBe('disconnected');
    });
  });

  describe('invalid transitions', () => {
    it('rejects transition from disconnected to connected', () => {
      expect(machine.setConnected()).toBe(false);
      expect(machine.state).toBe('disconnected');
    });

    it('rejects transition from connecting to connected', () => {
      machine.startConnecting();
      expect(machine.setConnected()).toBe(false);
      expect(machine.state).toBe('connecting');
    });

    it('rejects transition from connected to connecting', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      expect(machine.startConnecting()).toBe(false);
      expect(machine.state).toBe('connected');
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(machine.canTransition('connecting')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(machine.canTransition('connected')).toBe(false);
    });
  });

  describe('isIn and isInAny', () => {
    it('isIn returns true for current state', () => {
      expect(machine.isIn('disconnected')).toBe(true);
    });

    it('isIn returns false for other states', () => {
      expect(machine.isIn('connected')).toBe(false);
    });

    it('isInAny returns true if current state is in list', () => {
      machine.startConnecting();
      expect(machine.isInAny('connecting', 'setup_sent')).toBe(true);
    });

    it('isInAny returns false if current state not in list', () => {
      expect(machine.isInAny('connecting', 'connected')).toBe(false);
    });
  });

  describe('connectedAt timestamp', () => {
    it('sets connectedAt on setConnected', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      expect(machine.connectedAt).toBeDefined();
      expect(machine.connectedAt).toBeLessThanOrEqual(Date.now());
    });

    it('clears connectedAt on setDisconnected', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      machine.startClosing();
      machine.setDisconnected();
      expect(machine.connectedAt).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('resets to disconnected state', () => {
      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      machine.reset();
      expect(machine.state).toBe('disconnected');
    });

    it('clears connectedAt and lastError', () => {
      machine.startConnecting();
      machine.setError(new Error('test'));
      machine.reset();
      expect(machine.connectedAt).toBeUndefined();
      expect(machine.lastError).toBeUndefined();
    });
  });

  describe('event handlers', () => {
    it('calls handler on state change', () => {
      const handler = vi.fn();
      machine.on(handler);

      machine.startConnecting();

      expect(handler).toHaveBeenCalledWith('connecting', 'disconnected', undefined);
    });

    it('calls handler with reason', () => {
      const handler = vi.fn();
      machine.on(handler);

      machine.startConnecting();
      machine.setupSent();
      machine.setConnected();
      machine.startClosing('user requested');

      expect(handler).toHaveBeenLastCalledWith('closing', 'connected', 'user requested');
    });

    it('allows unsubscribing', () => {
      const handler = vi.fn();
      const unsubscribe = machine.on(handler);

      machine.startConnecting();
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      machine.setupSent();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('removeAllHandlers removes all handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      machine.on(handler1);
      machine.on(handler2);

      machine.startConnecting();
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      machine.removeAllHandlers();
      machine.setupSent();
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('handles exceptions in handlers gracefully', () => {
      const badHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = vi.fn();

      machine.on(badHandler);
      machine.on(goodHandler);

      // Should not throw
      machine.startConnecting();

      expect(badHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
    });
  });

  describe('forceState', () => {
    it('forces state without validation', () => {
      machine.forceState('connected', 'testing');
      expect(machine.state).toBe('connected');
    });

    it('calls handlers on forceState', () => {
      const handler = vi.fn();
      machine.on(handler);

      machine.forceState('error', 'forced for testing');

      expect(handler).toHaveBeenCalledWith('error', 'disconnected', 'forced for testing');
    });
  });
});

describe('SubscriptionStateMachine', () => {
  let machine: SubscriptionStateMachine;

  beforeEach(() => {
    machine = new SubscriptionStateMachine(42);
  });

  describe('initial state', () => {
    it('starts in pending state', () => {
      expect(machine.state).toBe('pending');
    });

    it('stores subscribeId', () => {
      expect(machine.subscribeId).toBe(42);
    });

    it('is not active initially', () => {
      expect(machine.isActive).toBe(false);
    });

    it('has not ended initially', () => {
      expect(machine.hasEnded).toBe(false);
    });
  });

  describe('setActive', () => {
    it('transitions to active state', () => {
      expect(machine.setActive(100, 1)).toBe(true);
      expect(machine.state).toBe('active');
      expect(machine.isActive).toBe(true);
    });

    it('stores trackAlias', () => {
      machine.setActive(100);
      expect(machine.trackAlias).toBe(100);
    });

    it('stores groupOrder', () => {
      machine.setActive(100, 2);
      expect(machine.groupOrder).toBe(2);
    });

    it('sets activeAt timestamp', () => {
      machine.setActive(100);
      expect(machine.activeAt).toBeDefined();
      expect(machine.activeAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('setEnded', () => {
    it('transitions from pending to ended', () => {
      expect(machine.setEnded('cancelled')).toBe(true);
      expect(machine.state).toBe('ended');
      expect(machine.hasEnded).toBe(true);
    });

    it('transitions from active to ended', () => {
      machine.setActive(100);
      expect(machine.setEnded('done')).toBe(true);
      expect(machine.state).toBe('ended');
    });

    it('cannot transition from ended', () => {
      machine.setEnded();
      expect(machine.setActive(100)).toBe(false);
    });
  });

  describe('setError', () => {
    it('transitions to error state', () => {
      expect(machine.setError(1, 'Track not found')).toBe(true);
      expect(machine.state).toBe('error');
      expect(machine.hasEnded).toBe(true);
    });

    it('stores error code and reason', () => {
      machine.setError(2, 'Internal error');
      expect(machine.errorCode).toBe(2);
      expect(machine.errorReason).toBe('Internal error');
    });

    it('transitions from active to error', () => {
      machine.setActive(100);
      expect(machine.setError(3, 'Publisher gone')).toBe(true);
      expect(machine.state).toBe('error');
    });

    it('cannot transition from error', () => {
      machine.setError(1, 'error');
      expect(machine.setActive(100)).toBe(false);
    });
  });

  describe('event handlers', () => {
    it('calls handler on setActive', () => {
      const handler = vi.fn();
      machine.on(handler);

      machine.setActive(100, 1);

      expect(handler).toHaveBeenCalledWith('active', 'pending', undefined);
    });

    it('calls handler on setError with reason', () => {
      const handler = vi.fn();
      machine.on(handler);

      machine.setError(1, 'Not found');

      expect(handler).toHaveBeenCalledWith('error', 'pending', 'Not found');
    });
  });
});

describe('AnnouncementStateMachine', () => {
  let machine: AnnouncementStateMachine;

  beforeEach(() => {
    machine = new AnnouncementStateMachine(['app', 'room1', 'media']);
  });

  describe('initial state', () => {
    it('starts in pending state', () => {
      expect(machine.state).toBe('pending');
    });

    it('stores namespace', () => {
      expect(machine.namespace).toEqual(['app', 'room1', 'media']);
    });

    it('is not active initially', () => {
      expect(machine.isActive).toBe(false);
    });
  });

  describe('setActive', () => {
    it('transitions to active state', () => {
      expect(machine.setActive()).toBe(true);
      expect(machine.state).toBe('active');
      expect(machine.isActive).toBe(true);
    });

    it('sets activeAt timestamp', () => {
      machine.setActive();
      expect(machine.activeAt).toBeDefined();
    });
  });

  describe('setEnded', () => {
    it('transitions from pending to ended', () => {
      expect(machine.setEnded('cancelled')).toBe(true);
      expect(machine.state).toBe('ended');
      expect(machine.hasEnded).toBe(true);
    });

    it('transitions from active to ended', () => {
      machine.setActive();
      expect(machine.setEnded()).toBe(true);
      expect(machine.state).toBe('ended');
    });
  });

  describe('setError', () => {
    it('transitions to error state', () => {
      expect(machine.setError(1, 'Namespace in use')).toBe(true);
      expect(machine.state).toBe('error');
    });

    it('stores error info', () => {
      machine.setError(2, 'Not authorized');
      expect(machine.errorCode).toBe(2);
      expect(machine.errorReason).toBe('Not authorized');
    });
  });
});

describe('NamespaceSubscriptionStateMachine', () => {
  let machine: NamespaceSubscriptionStateMachine;

  beforeEach(() => {
    machine = new NamespaceSubscriptionStateMachine(['app', 'room1']);
  });

  describe('initial state', () => {
    it('starts in pending state', () => {
      expect(machine.state).toBe('pending');
    });

    it('stores namespace prefix', () => {
      expect(machine.namespacePrefix).toEqual(['app', 'room1']);
    });

    it('is not active initially', () => {
      expect(machine.isActive).toBe(false);
    });
  });

  describe('setActive', () => {
    it('transitions to active state', () => {
      expect(machine.setActive()).toBe(true);
      expect(machine.state).toBe('active');
      expect(machine.isActive).toBe(true);
    });
  });

  describe('setEnded', () => {
    it('transitions to ended state', () => {
      machine.setActive();
      expect(machine.setEnded('unsubscribed')).toBe(true);
      expect(machine.state).toBe('ended');
    });
  });

  describe('setError', () => {
    it('transitions to error state with info', () => {
      expect(machine.setError(1, 'Unauthorized')).toBe(true);
      expect(machine.state).toBe('error');
      expect(machine.errorCode).toBe(1);
      expect(machine.errorReason).toBe('Unauthorized');
    });
  });
});
