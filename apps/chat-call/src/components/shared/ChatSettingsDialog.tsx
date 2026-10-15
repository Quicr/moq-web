import { useState } from 'react';
import { SettingsDialog } from '@moq-web/app-kit';
import { useMoqtStore } from '../../stores/moqt-store';

interface TopNPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenTransport: () => void;
}

/**
 * Chat-specific settings popover for Top-N active speaker.
 * Shown alongside the main transport SettingsDialog.
 */
export function ChatSettingsDialog({ open, onClose, onOpenTransport }: TopNPanelProps) {
  const topNEnabled = useMoqtStore((s) => s.topNEnabled);
  const topNMaxTracks = useMoqtStore((s) => s.topNMaxTracks);
  const setTopN = useMoqtStore((s) => s.setTopN);

  if (!open) return null;

  return (
    <div
      className="ak-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="ak-modal"
        style={{ maxWidth: 480, width: '100%', margin: '10vh auto', animation: 'ak-scale-in 200ms ease' }}
      >
        <div className="ak-modal-header">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--ak-fg)' }}>
              Top-N Active Speaker
            </h2>
            <div className="ak-caption" style={{ marginTop: 4 }}>
              Relay-side filtering for large conferences
            </div>
          </div>
          <button className="ak-icon-btn" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="ak-modal-body">
          <div className="ak-settings-card">
            {/* Enable toggle */}
            <div className="ak-row-between">
              <div>
                <div style={{ fontWeight: 500, color: 'var(--ak-fg)' }}>Enable Top-N</div>
                <div className="ak-subtle">
                  Relay forwards only the top-N active speakers' video
                </div>
              </div>
              <label className="ak-toggle">
                <input
                  type="checkbox"
                  checked={topNEnabled}
                  onChange={(e) => setTopN(e.target.checked)}
                />
                <span />
              </label>
            </div>

            {topNEnabled && (
              <>
                {/* Max tracks */}
                <div className="ak-row-between">
                  <div>
                    <div style={{ fontWeight: 500, color: 'var(--ak-fg)' }}>Max video tracks (N)</div>
                    <div className="ak-subtle">Number of video streams to receive</div>
                  </div>
                  <select
                    className="ak-select"
                    style={{ width: 80 }}
                    value={topNMaxTracks}
                    onChange={(e) => setTopN(true, Number(e.target.value))}
                  >
                    {[2, 4, 6, 9].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>

                {/* Info */}
                <div className="ak-settings-card" style={{ padding: 12, gap: 6 }}>
                  <div className="ak-caption">Publisher</div>
                  <div className="ak-subtle">
                    VAD: energy-based (built-in) &middot; Activity header: ID 12 &middot;
                    Keyframe on speech start
                  </div>
                  <div className="ak-caption" style={{ marginTop: 8 }}>Subscriber</div>
                  <div className="ak-subtle">
                    Track filter: TRACK_PROPERTY_FILTER (0x29) &middot;
                    Timeout: 5s &middot; Slot stabilization enabled
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="ak-row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
            <button className="ak-btn ak-btn-ghost" onClick={onOpenTransport}>
              Transport settings...
            </button>
            <button className="ak-btn ak-btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Combined settings button that manages both the chat settings
 * and the transport settings dialogs.
 */
export function SettingsButtons() {
  const [chatOpen, setChatOpen] = useState(false);
  const [transportOpen, setTransportOpen] = useState(false);
  const topNEnabled = useMoqtStore((s) => s.topNEnabled);

  return (
    <>
      <button
        type="button"
        className="ak-icon-btn"
        onClick={() => setChatOpen(true)}
        aria-label="Top-N settings"
        title="Top-N active speaker"
        style={topNEnabled ? {
          background: 'var(--ak-accent-soft)',
          color: 'var(--ak-accent)',
        } : undefined}
      >
        <span className="material-icon" style={{ fontSize: 18 }}>record_voice_over</span>
      </button>
      <button
        type="button"
        className="ak-icon-btn"
        onClick={() => setTransportOpen(true)}
        aria-label="Transport settings"
        title="Transport settings"
      >
        <span style={{ fontSize: 18 }}>&#9881;</span>
      </button>
      <ChatSettingsDialog
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onOpenTransport={() => {
          setChatOpen(false);
          setTransportOpen(true);
        }}
      />
      <SettingsDialog open={transportOpen} onClose={() => setTransportOpen(false)} />
    </>
  );
}
