// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Message Log Panel
 *
 * Glassmorphism-styled panel showing sent/received MOQ messages.
 * Provides real-time visibility into protocol message flow.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Message log event data
 */
export interface MessageLogEvent {
  messageType: string;
  timestamp: number;
  bytes: number;
  summary: string;
  details?: Record<string, unknown>;
}

export interface MessageLogEntry {
  id: number;
  direction: 'sent' | 'received';
  messageType: string;
  timestamp: number;
  bytes: number;
  summary: string;
  details?: Record<string, unknown>;
}

interface MessageLogPanelProps {
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Toggle panel visibility */
  onToggle: () => void;
  /** Session to listen to (optional - can use addEntry directly) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session?: any;
  /** Maximum entries to keep */
  maxEntries?: number;
}

/**
 * Format timestamp as HH:MM:SS.mmm
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * Get color for message type
 */
function getMessageTypeColor(messageType: string): string {
  if (messageType.includes('ERROR')) return 'text-red-400';
  if (messageType.includes('OK')) return 'text-emerald-400';
  if (messageType === 'SUBSCRIBE' || messageType === 'PUBLISH') return 'text-blue-400';
  if (messageType === 'FETCH') return 'text-purple-400';
  if (messageType.includes('SETUP')) return 'text-amber-400';
  return 'text-slate-300';
}

export function MessageLogPanel({
  isOpen,
  onToggle,
  session,
  maxEntries = 100,
}: MessageLogPanelProps) {
  const [entries, setEntries] = useState<MessageLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'sent' | 'received'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(1);

  // Add entry function
  const addEntry = useCallback((direction: 'sent' | 'received', event: MessageLogEvent) => {
    setEntries(prev => {
      const newEntry: MessageLogEntry = {
        ...event,
        id: nextIdRef.current++,
        direction,
      };
      const updated = [...prev, newEntry];
      // Keep only last maxEntries
      if (updated.length > maxEntries) {
        return updated.slice(-maxEntries);
      }
      return updated;
    });
  }, [maxEntries]);

  // Subscribe to session events
  useEffect(() => {
    if (!session) return;

    const cleanupSent = session.on('message-sent', (event: MessageLogEvent) => {
      addEntry('sent', event);
    });

    const cleanupReceived = session.on('message-received', (event: MessageLogEvent) => {
      addEntry('received', event);
    });

    return () => {
      cleanupSent();
      cleanupReceived();
    };
  }, [session, addEntry]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Handle scroll to detect manual scrolling
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  // Clear log
  const handleClear = useCallback(() => {
    setEntries([]);
    nextIdRef.current = 1;
  }, []);

  // Filter entries
  const filteredEntries = filter === 'all'
    ? entries
    : entries.filter(e => e.direction === filter);

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-xl
                   bg-slate-900/70 backdrop-blur-xl border border-slate-700/50
                   text-slate-300 text-sm font-medium
                   hover:bg-slate-800/80 hover:border-slate-600/50
                   transition-all duration-200 shadow-lg shadow-black/20"
      >
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Messages {entries.length > 0 && <span className="text-xs text-slate-500">({entries.length})</span>}
        </span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 h-64
                    bg-slate-900/80 backdrop-blur-2xl
                    border-t border-slate-700/50
                    shadow-2xl shadow-black/40">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700/30">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-semibold text-slate-200">Message Log</h3>

          {/* Filter buttons */}
          <div className="flex gap-1 bg-slate-800/50 rounded-lg p-0.5">
            {(['all', 'sent', 'received'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-all duration-150
                           ${filter === f
                             ? 'bg-slate-700 text-white shadow-sm'
                             : 'text-slate-400 hover:text-slate-200'}`}
              >
                {f === 'all' ? 'All' : f === 'sent' ? 'Sent' : 'Recv'}
              </button>
            ))}
          </div>

          <span className="text-xs text-slate-500">
            {filteredEntries.length} messages
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Auto-scroll toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-1 text-xs rounded-md transition-all duration-150
                       ${autoScroll
                         ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                         : 'text-slate-500 hover:text-slate-300'}`}
          >
            Auto-scroll
          </button>

          {/* Clear button */}
          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200
                       rounded-md hover:bg-slate-700/50 transition-all duration-150"
          >
            Clear
          </button>

          {/* Close button */}
          <button
            onClick={onToggle}
            className="p-1.5 text-slate-400 hover:text-slate-200
                       rounded-lg hover:bg-slate-700/50 transition-all duration-150"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-[calc(100%-44px)] overflow-y-auto overflow-x-hidden
                   scrollbar-thin scrollbar-track-slate-800/50 scrollbar-thumb-slate-600/50"
      >
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            No messages yet
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filteredEntries.map(entry => (
              <div
                key={entry.id}
                className={`flex items-start gap-3 px-3 py-1.5 rounded-lg
                           transition-all duration-150 hover:bg-slate-800/40
                           ${entry.direction === 'sent'
                             ? 'border-l-2 border-l-blue-500/50 bg-blue-500/5'
                             : 'border-l-2 border-l-emerald-500/50 bg-emerald-500/5'}`}
              >
                {/* Direction indicator */}
                <div className={`flex-shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center
                                ${entry.direction === 'sent'
                                  ? 'bg-blue-500/20 text-blue-400'
                                  : 'bg-emerald-500/20 text-emerald-400'}`}>
                  {entry.direction === 'sent' ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  )}
                </div>

                {/* Timestamp */}
                <span className="flex-shrink-0 text-xs font-mono text-slate-500 w-24">
                  {formatTime(entry.timestamp)}
                </span>

                {/* Message type */}
                <span className={`flex-shrink-0 text-xs font-semibold font-mono w-28 ${getMessageTypeColor(entry.messageType)}`}>
                  {entry.messageType}
                </span>

                {/* Summary */}
                <span className="text-xs text-slate-300 font-mono truncate flex-1">
                  {entry.summary}
                </span>

                {/* Bytes (if non-zero) */}
                {entry.bytes > 0 && (
                  <span className="flex-shrink-0 text-xs text-slate-600 font-mono">
                    {entry.bytes}B
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageLogPanel;
