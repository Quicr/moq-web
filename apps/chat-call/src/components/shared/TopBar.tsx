import { useEffect, useState } from 'react';
import { DraftSwitch, ThemeSwitch, TransportConfigPanel, useTransportConfig } from '@moq-web/app-kit';

export function TopBar() {
  const [open, setOpen] = useState(false);
  const cfg = useTransportConfig();

  useEffect(() => {
    if (!open) return;
    const listener = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open]);

  return (
    <>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
        className="ak-glass"
      >
        <span className="ak-caption">chat + call</span>
        <span className="ak-chip ak-chip-neutral">{cfg.profile}</span>
        <span className="ak-chip ak-chip-neutral">{cfg.publisher.deliveryMode}</span>
        <div style={{ flex: 1 }} />
        <DraftSwitch />
        <ThemeSwitch />
        <button className="ak-btn ak-btn-primary" onClick={() => setOpen(true)}>
          ⚙ Settings
        </button>
      </header>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(6, 8, 20, 0.55)',
            backdropFilter: 'blur(6px)',
            zIndex: 50,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(760px, 100%)',
              height: '100%',
              background: 'var(--ak-bg)',
              boxShadow: 'var(--ak-shadow-2)',
              padding: 20,
              overflow: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div className="ak-caption">Transport & playback</div>
                <div className="ak-title" style={{ fontSize: 20 }}>Settings</div>
              </div>
              <div style={{ flex: 1 }} />
              <button className="ak-btn" onClick={() => setOpen(false)}>Close</button>
            </div>
            <TransportConfigPanel />
          </div>
        </div>
      )}
    </>
  );
}
