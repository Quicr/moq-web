// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Decode Error Toast Component
 *
 * Displays decode errors as dismissible toasts with diagnostic information.
 */

import React from 'react';
import { useStore, type DecodeErrorEntry } from '../../store';

/**
 * Format diagnostic info for display
 */
function formatDiagnostics(diagnostics: DecodeErrorEntry['diagnostics']): string {
  if (!diagnostics) return '';

  const parts: string[] = [];

  if (diagnostics.mediaType) {
    parts.push(`Type: ${diagnostics.mediaType}`);
  }

  if (diagnostics.groupId !== undefined && diagnostics.objectId !== undefined) {
    parts.push(`Frame: g${diagnostics.groupId}/o${diagnostics.objectId}`);
  }

  if (diagnostics.isKeyframe !== undefined) {
    parts.push(diagnostics.isKeyframe ? 'Keyframe' : 'Delta frame');
  }

  if (diagnostics.dataSize !== undefined) {
    parts.push(`Size: ${diagnostics.dataSize} bytes`);
  }

  if (diagnostics.framesDecodedBefore !== undefined) {
    parts.push(`Decoded before error: ${diagnostics.framesDecodedBefore} frames`);
  }

  if (diagnostics.keyframesReceived !== undefined) {
    parts.push(`Keyframes received: ${diagnostics.keyframesReceived}`);
  }

  if (!diagnostics.hadKeyframe) {
    parts.push('No keyframe received yet');
  }

  return parts.join(' | ');
}

/**
 * Single error toast item
 */
const ErrorToastItem: React.FC<{ error: DecodeErrorEntry; onDismiss: () => void }> = ({ error, onDismiss }) => {
  const diagnosticText = formatDiagnostics(error.diagnostics);
  const timeAgo = Math.round((Date.now() - error.timestamp) / 1000);

  return (
    <div className="bg-red-100 dark:bg-red-900/40 border border-red-300 dark:border-red-700 rounded-lg p-3 shadow-lg animate-slide-in">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm font-medium text-red-800 dark:text-red-200">
              Decode Error
            </span>
            <span className="text-xs text-red-600 dark:text-red-400">
              {timeAgo}s ago
            </span>
          </div>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            {error.message}
          </p>
          {diagnosticText && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400 font-mono">
              {diagnosticText}
            </p>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 p-1"
          title="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

/**
 * Decode Error Toast Container
 *
 * Displays recent decode errors as dismissible toasts in the top-right corner.
 */
export const DecodeErrorToast: React.FC = () => {
  const { decodeErrors, clearDecodeErrors } = useStore();

  // Auto-dismiss errors after 30 seconds
  React.useEffect(() => {
    if (decodeErrors.length === 0) return;

    const timer = setTimeout(() => {
      // Remove errors older than 30 seconds
      const { decodeErrors: current } = useStore.getState();
      const cutoff = Date.now() - 30000;
      const filtered = current.filter(e => e.timestamp > cutoff);
      if (filtered.length !== current.length) {
        useStore.setState({ decodeErrors: filtered });
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [decodeErrors]);

  if (decodeErrors.length === 0) return null;

  const dismissError = (id: number) => {
    const { decodeErrors: current } = useStore.getState();
    useStore.setState({ decodeErrors: current.filter(e => e.id !== id) });
  };

  return (
    <div className="fixed top-20 right-4 z-50 w-96 space-y-2">
      {decodeErrors.length > 1 && (
        <div className="flex justify-end">
          <button
            onClick={clearDecodeErrors}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear all ({decodeErrors.length})
          </button>
        </div>
      )}
      {decodeErrors.slice(0, 3).map(error => (
        <ErrorToastItem
          key={error.id}
          error={error}
          onDismiss={() => dismissError(error.id)}
        />
      ))}
      {decodeErrors.length > 3 && (
        <div className="text-center text-xs text-gray-500 dark:text-gray-400">
          +{decodeErrors.length - 3} more errors
        </div>
      )}
    </div>
  );
};
