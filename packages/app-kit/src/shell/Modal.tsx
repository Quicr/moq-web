// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  /** Max width in px; defaults to 960. */
  maxWidth?: number;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, subtitle, maxWidth = 960, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="ak-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="ak-glass-strong ak-modal"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <div className="ak-modal-header">
            <div>
              {title && <div className="ak-title" style={{ fontSize: 20 }}>{title}</div>}
              {subtitle && <div className="ak-subtle" style={{ marginTop: 4 }}>{subtitle}</div>}
            </div>
            <button
              className="ak-btn ak-btn-ghost"
              onClick={onClose}
              aria-label="Close"
              style={{ padding: '4px 10px', fontSize: 18, lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
        )}
        <div className="ak-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
