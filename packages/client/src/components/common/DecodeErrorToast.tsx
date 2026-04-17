// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Decode Error Banner Component
 *
 * Displays decode errors as a compact, non-blocking banner that shows error count
 * and allows expansion to view details. Designed to not interrupt video playback.
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
 * Decode Error Banner
 *
 * Shows a compact banner when decode errors occur. The banner:
 * - Shows error count that updates as more errors arrive
 * - Can be expanded to show the most recent error details
 * - Does not block video rendering
 * - Auto-dismisses after 30 seconds of no new errors
 */
export const DecodeErrorToast: React.FC = () => {
  const { decodeErrors, clearDecodeErrors } = useStore();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [lastErrorCount, setLastErrorCount] = React.useState(0);

  // Auto-collapse and clear errors after 30 seconds of no new errors
  React.useEffect(() => {
    if (decodeErrors.length === 0) return;

    // Flash the banner when new errors arrive
    if (decodeErrors.length > lastErrorCount) {
      setLastErrorCount(decodeErrors.length);
    }

    const timer = setTimeout(() => {
      // Remove errors older than 30 seconds
      const { decodeErrors: current } = useStore.getState();
      const cutoff = Date.now() - 30000;
      const filtered = current.filter(e => e.timestamp > cutoff);
      if (filtered.length !== current.length) {
        useStore.setState({ decodeErrors: filtered });
        if (filtered.length === 0) {
          setIsExpanded(false);
          setLastErrorCount(0);
        }
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [decodeErrors, lastErrorCount]);

  if (decodeErrors.length === 0) return null;

  const latestError = decodeErrors[0];
  const diagnosticText = formatDiagnostics(latestError?.diagnostics);

  return (
    <div className="fixed top-20 right-4 z-50 w-auto max-w-md">
      {/* Compact banner */}
      <div
        className="bg-red-100 dark:bg-red-900/40 border border-red-300 dark:border-red-700 rounded-lg shadow-lg cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm font-medium text-red-800 dark:text-red-200">
              Decode Errors: {decodeErrors.length}
            </span>
            <span className="text-xs text-red-600 dark:text-red-400">
              (decoder recovering)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <svg
              className={`w-4 h-4 text-red-500 dark:text-red-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            <button
              onClick={(e) => {
                e.stopPropagation();
                clearDecodeErrors();
                setIsExpanded(false);
                setLastErrorCount(0);
              }}
              className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 p-1"
              title="Dismiss all"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {isExpanded && latestError && (
          <div className="border-t border-red-300 dark:border-red-700 px-3 py-2">
            <p className="text-xs text-red-600 dark:text-red-400 mb-1">
              Latest error:
            </p>
            <p className="text-sm text-red-700 dark:text-red-300">
              {latestError.message}
            </p>
            {diagnosticText && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400 font-mono break-all">
                {diagnosticText}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
