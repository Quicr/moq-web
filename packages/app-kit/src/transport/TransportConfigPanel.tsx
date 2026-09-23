// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useState } from 'react';
import {
  LATENCY_PROFILES,
  LATENCY_PROFILE_ORDER,
} from '../latency/profiles.js';
import { useTransportActions, useTransportConfig } from './state.js';
import { Toggle } from '../shell/Toggle.js';
import { GlassPanel } from '../shell/GlassPanel.js';

type SectionId = 'profile' | 'relay' | 'publisher' | 'subscriber' | 'playback';

const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
  { id: 'profile', label: 'Latency profile', hint: 'One-click presets' },
  { id: 'relay', label: 'Relay', hint: 'Endpoints & failover' },
  { id: 'publisher', label: 'Publisher', hint: 'Delivery mode & priority' },
  { id: 'subscriber', label: 'Subscriber', hint: 'Filter, priority, NGR' },
  { id: 'playback', label: 'Playback', hint: 'Jitter & catch-up' },
];

function SectionNav({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id)}
          className="ak-btn ak-btn-ghost"
          style={{
            justifyContent: 'flex-start',
            padding: '10px 12px',
            background: active === s.id ? 'var(--ak-accent-soft)' : 'transparent',
            color: active === s.id ? 'var(--ak-fg)' : 'var(--ak-fg-muted)',
            border: 'none',
            borderRadius: 12,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
            <span className="ak-subtle" style={{ fontSize: 11 }}>{s.hint}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ProfileSection() {
  const cfg = useTransportConfig();
  const { applyProfile, setTargetLatency } = useTransportActions();
  return (
    <div className="ak-stack">
      <div className="ak-grid-2">
        {LATENCY_PROFILE_ORDER.map((name) => {
          const p = LATENCY_PROFILES[name];
          const active = cfg.profile === name;
          return (
            <button
              key={name}
              onClick={() => applyProfile(name)}
              className="ak-glass"
              style={{
                padding: 14,
                textAlign: 'left',
                cursor: 'pointer',
                border: active ? '1px solid var(--ak-accent)' : '1px solid var(--ak-border)',
                boxShadow: active ? 'var(--ak-shadow-glow)' : 'var(--ak-shadow-1)',
                background: active ? 'var(--ak-accent-soft)' : 'var(--ak-bg-elev)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.displayName}</span>
                <span className="ak-chip ak-chip-neutral">{p.targetLatency} ms</span>
              </div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>{p.description}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                <span className="ak-chip ak-chip-neutral">{p.publisher.deliveryMode}</span>
                <span className="ak-chip ak-chip-neutral">pri {p.publisher.publisherPriority}</span>
                {p.subscriber.requestNewGroupOnJoin && <span className="ak-chip">NGR</span>}
              </div>
            </button>
          );
        })}
        <button
          onClick={() => applyProfile('custom')}
          className="ak-glass"
          style={{
            padding: 14,
            textAlign: 'left',
            cursor: 'pointer',
            border: cfg.profile === 'custom' ? '1px solid var(--ak-accent)' : '1px dashed var(--ak-border-strong)',
            background: cfg.profile === 'custom' ? 'var(--ak-accent-soft)' : 'transparent',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13 }}>Custom</div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>Tweak any knob below</div>
        </button>
      </div>
      <div className="ak-divider" />
      <label>
        <div className="ak-caption" style={{ marginBottom: 6 }}>Target latency ({cfg.targetLatencyMs} ms)</div>
        <input
          type="range"
          min={20}
          max={10000}
          step={10}
          value={cfg.targetLatencyMs}
          onChange={(e) => setTargetLatency(Number(e.target.value))}
          className="ak-range"
        />
      </label>
    </div>
  );
}

function RelaySection() {
  const cfg = useTransportConfig();
  const { setRelay, addRelay, removeRelay, reorderRelay } = useTransportActions();
  const [draft, setDraft] = useState('');
  return (
    <div className="ak-stack">
      <div>
        <div className="ak-caption" style={{ marginBottom: 8 }}>Relay endpoints (first = primary, others = failover)</div>
        <div className="ak-stack" style={{ gap: 8 }}>
          {cfg.relay.relays.map((url, i) => (
            <div key={`${url}-${i}`} className="ak-row-between">
              <input value={url} readOnly className="ak-input ak-input-mono" style={{ flex: 1 }} />
              <button
                className="ak-btn ak-btn-ghost"
                onClick={() => reorderRelay(i, Math.max(0, i - 1))}
                disabled={i === 0}
                title="Move up"
              >
                ↑
              </button>
              <button
                className="ak-btn ak-btn-ghost"
                onClick={() => reorderRelay(i, Math.min(cfg.relay.relays.length - 1, i + 1))}
                disabled={i === cfg.relay.relays.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button
                className="ak-btn ak-btn-ghost"
                onClick={() => removeRelay(i)}
                title="Remove"
                style={{ color: 'var(--ak-danger)' }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="ak-row" style={{ marginTop: 4 }}>
        <input
          className="ak-input ak-input-mono"
          placeholder="https://relay.example.com:4433/moq"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className="ak-btn ak-btn-primary"
          onClick={() => {
            const trimmed = draft.trim();
            if (!trimmed) return;
            addRelay(trimmed);
            setDraft('');
          }}
        >
          Add relay
        </button>
      </div>
      <div className="ak-divider" />
      <div className="ak-grid-2">
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Draft version</div>
          <select
            className="ak-select"
            value={cfg.relay.draft}
            onChange={(e) => setRelay({ draft: e.target.value as 'draft-16' | 'draft-18' })}
          >
            <option value="draft-16">draft-16</option>
            <option value="draft-18">draft-18</option>
          </select>
        </label>
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Keep-alive ({cfg.relay.keepAliveMs} ms)</div>
          <input
            type="range"
            min={0}
            max={60_000}
            step={1000}
            value={cfg.relay.keepAliveMs}
            onChange={(e) => setRelay({ keepAliveMs: Number(e.target.value) })}
            className="ak-range"
          />
        </label>
      </div>
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Auto-reconnect</div>
          <div className="ak-subtle">Retry with exponential backoff on transport failure</div>
        </div>
        <Toggle checked={cfg.relay.autoReconnect} onChange={(v) => setRelay({ autoReconnect: v })} />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label>
      <div className="ak-caption" style={{ marginBottom: 6 }}>
        {label} ({value}{suffix ? ` ${suffix}` : ''})
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ak-range"
      />
    </label>
  );
}

function PublisherSection() {
  const cfg = useTransportConfig();
  const { setPublisher } = useTransportActions();
  return (
    <div className="ak-stack">
      <div className="ak-grid-2">
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Delivery mode</div>
          <select
            className="ak-select"
            value={cfg.publisher.deliveryMode}
            onChange={(e) => setPublisher({ deliveryMode: e.target.value as 'stream' | 'datagram' })}
          >
            <option value="datagram">Datagram (unreliable, lowest latency)</option>
            <option value="stream">Stream (reliable, ordered)</option>
          </select>
        </label>
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Group order</div>
          <select
            className="ak-select"
            value={cfg.publisher.groupOrder}
            onChange={(e) => setPublisher({ groupOrder: e.target.value as 'ascending' | 'descending' })}
          >
            <option value="ascending">Ascending (live)</option>
            <option value="descending">Descending (rewind)</option>
          </select>
        </label>
      </div>
      <NumberField
        label="Publisher priority"
        value={cfg.publisher.publisherPriority}
        min={0}
        max={255}
        step={1}
        onChange={(v) => setPublisher({ publisherPriority: v })}
      />
      <NumberField
        label="Object delivery timeout"
        value={cfg.publisher.objectDeliveryTimeoutMs ?? 0}
        min={0}
        max={10_000}
        step={50}
        onChange={(v) => setPublisher({ objectDeliveryTimeoutMs: v === 0 ? undefined : v })}
        suffix="ms (0 = disabled)"
      />
      <NumberField
        label="Max cache duration"
        value={cfg.publisher.maxCacheDurationMs ?? 0}
        min={0}
        max={600_000}
        step={1000}
        onChange={(v) => setPublisher({ maxCacheDurationMs: v === 0 ? undefined : v })}
        suffix="ms"
      />
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Stream-per-group</div>
          <div className="ak-subtle">Open a new stream at every keyframe (stream mode only)</div>
        </div>
        <Toggle
          checked={cfg.publisher.streamPerGroup}
          onChange={(v) => setPublisher({ streamPerGroup: v })}
          disabled={cfg.publisher.deliveryMode !== 'stream'}
        />
      </div>
    </div>
  );
}

function SubscriberSection() {
  const cfg = useTransportConfig();
  const { setSubscriber } = useTransportActions();
  return (
    <div className="ak-stack">
      <div className="ak-grid-2">
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Filter</div>
          <select
            className="ak-select"
            value={cfg.subscriber.filterType}
            onChange={(e) => setSubscriber({ filterType: e.target.value as never })}
          >
            <option value="latest-object">Latest object</option>
            <option value="latest-group">Latest group</option>
            <option value="absolute-start">Absolute start</option>
            <option value="absolute-range">Absolute range</option>
          </select>
        </label>
        <label>
          <div className="ak-caption" style={{ marginBottom: 6 }}>Group order</div>
          <select
            className="ak-select"
            value={cfg.subscriber.groupOrder}
            onChange={(e) => setSubscriber({ groupOrder: e.target.value as never })}
          >
            <option value="ascending">Ascending (live)</option>
            <option value="descending">Descending (rewind)</option>
          </select>
        </label>
      </div>
      <NumberField
        label="Subscriber priority"
        value={cfg.subscriber.subscriberPriority}
        min={0}
        max={255}
        step={1}
        onChange={(v) => setSubscriber({ subscriberPriority: v })}
      />
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Forward objects</div>
          <div className="ak-subtle">Relay pushes objects immediately (forward=1)</div>
        </div>
        <Toggle checked={cfg.subscriber.forward} onChange={(v) => setSubscriber({ forward: v })} />
      </div>
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Request new group on join</div>
          <div className="ak-subtle">Draft-18 §10.2.13 NEW_GROUP_REQUEST — get a fresh keyframe on subscribe</div>
        </div>
        <Toggle
          checked={cfg.subscriber.requestNewGroupOnJoin}
          onChange={(v) => setSubscriber({ requestNewGroupOnJoin: v })}
        />
      </div>
    </div>
  );
}

function PlaybackSection() {
  const cfg = useTransportConfig();
  const { setPlayback } = useTransportActions();
  const p = cfg.playback;
  return (
    <div className="ak-stack">
      <NumberField label="Jitter buffer" value={p.jitterBufferDelay} min={0} max={3000} step={10} onChange={(v) => setPlayback({ jitterBufferDelay: v })} suffix="ms" />
      <NumberField label="Max latency" value={p.maxLatency === Infinity ? 10_000 : p.maxLatency} min={0} max={10_000} step={50} onChange={(v) => setPlayback({ maxLatency: v })} suffix="ms" />
      <NumberField label="Estimated GOP duration" value={p.estimatedGopDuration} min={100} max={5000} step={100} onChange={(v) => setPlayback({ estimatedGopDuration: v })} suffix="ms" />
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Use latency deadline</div>
          <div className="ak-subtle">Interactive frame policy vs streaming</div>
        </div>
        <Toggle checked={p.useLatencyDeadline} onChange={(v) => setPlayback({ useLatencyDeadline: v })} />
      </div>
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Skip to latest group</div>
          <div className="ak-subtle">Jump forward to keyframes when behind</div>
        </div>
        <Toggle checked={p.skipToLatestGroup} onChange={(v) => setPlayback({ skipToLatestGroup: v })} />
      </div>
      <div className="ak-row-between">
        <div>
          <div className="ak-heading">Catch-up mode</div>
          <div className="ak-subtle">Fast-forward when buffer overfills</div>
        </div>
        <Toggle checked={p.enableCatchUp} onChange={(v) => setPlayback({ enableCatchUp: v })} />
      </div>
    </div>
  );
}

export interface TransportConfigPanelProps {
  defaultSection?: SectionId;
}

export function TransportConfigPanel({ defaultSection = 'profile' }: TransportConfigPanelProps) {
  const [active, setActive] = useState<SectionId>(defaultSection);
  const { reset } = useTransportActions();
  return (
    <GlassPanel strong padding="sm">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 220px) 1fr',
          gap: 12,
          minHeight: 420,
        }}
      >
        <div
          className="ak-glass"
          style={{
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <SectionNav active={active} onSelect={setActive} />
          <button
            className="ak-btn ak-btn-ghost"
            onClick={reset}
            style={{ margin: 8, justifyContent: 'flex-start' }}
          >
            ↺ Reset to defaults
          </button>
        </div>
        <div className="ak-glass" style={{ padding: 20 }}>
          {active === 'profile' && <ProfileSection />}
          {active === 'relay' && <RelaySection />}
          {active === 'publisher' && <PublisherSection />}
          {active === 'subscriber' && <SubscriberSection />}
          {active === 'playback' && <PlaybackSection />}
        </div>
      </div>
    </GlassPanel>
  );
}
