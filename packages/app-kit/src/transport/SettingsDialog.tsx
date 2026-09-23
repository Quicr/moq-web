// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useState } from 'react';
import {
  LATENCY_PROFILES,
  LATENCY_PROFILE_ORDER,
} from '../latency/profiles.js';
import { Modal } from '../shell/Modal.js';
import { Toggle } from '../shell/Toggle.js';
import { useTransportActions, useTransportConfig } from './state.js';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Card-layout settings dialog. Each of the 5 categories is its own glass card
 * so the dense knob list is easier to scan than the previous side-nav layout.
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { reset } = useTransportActions();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      subtitle="Transport, playback, and relay endpoints for this app."
      maxWidth={1080}
    >
      <div className="ak-settings-grid">
        <ProfileCard />
        <RelayCard />
        <PublisherCard />
        <SubscriberCard />
        <PlaybackCard />
      </div>
      <div className="ak-row" style={{ marginTop: 16, justifyContent: 'flex-end', gap: 8 }}>
        <button className="ak-btn ak-btn-ghost" onClick={reset}>↺ Reset to defaults</button>
        <button className="ak-btn ak-btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

function CardHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h3>{title}</h3>
      <div className="ak-caption" style={{ marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function ProfileCard() {
  const cfg = useTransportConfig();
  const { applyProfile, setTargetLatency } = useTransportActions();
  return (
    <div className="ak-settings-card">
      <CardHeader title="Latency profile" hint="One-click presets" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {LATENCY_PROFILE_ORDER.map((name) => {
          const p = LATENCY_PROFILES[name];
          const active = cfg.profile === name;
          return (
            <button
              key={name}
              onClick={() => applyProfile(name)}
              style={{
                padding: 10,
                textAlign: 'left',
                cursor: 'pointer',
                border: active ? '1px solid var(--ak-accent)' : '1px solid var(--ak-border)',
                background: active ? 'var(--ak-accent-soft)' : 'var(--ak-bg-elev-strong)',
                borderRadius: 10,
                color: 'var(--ak-fg)',
              }}
            >
              <div className="ak-row-between">
                <span style={{ fontWeight: 600, fontSize: 12 }}>{p.displayName}</span>
                <span className="ak-chip ak-chip-neutral" style={{ fontSize: 10 }}>{p.targetLatency}ms</span>
              </div>
              <div className="ak-subtle" style={{ fontSize: 11, marginTop: 4 }}>{p.publisher.deliveryMode} · pri {p.publisher.publisherPriority}</div>
            </button>
          );
        })}
        <button
          onClick={() => applyProfile('custom')}
          style={{
            padding: 10,
            textAlign: 'left',
            cursor: 'pointer',
            border: cfg.profile === 'custom' ? '1px solid var(--ak-accent)' : '1px dashed var(--ak-border-strong)',
            background: cfg.profile === 'custom' ? 'var(--ak-accent-soft)' : 'transparent',
            borderRadius: 10,
            color: 'var(--ak-fg)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12 }}>Custom</div>
          <div className="ak-subtle" style={{ fontSize: 11 }}>Tweak any knob</div>
        </button>
      </div>
      <NumberField
        label="Target latency"
        value={cfg.targetLatencyMs}
        min={20}
        max={10_000}
        step={10}
        suffix="ms"
        onChange={(v) => setTargetLatency(v)}
      />
    </div>
  );
}

function RelayCard() {
  const cfg = useTransportConfig();
  const { setRelay, addRelay, removeRelay, reorderRelay } = useTransportActions();
  const [draft, setDraft] = useState('');
  return (
    <div className="ak-settings-card">
      <CardHeader title="Relay" hint="Endpoints try in order; first wins" />
      <div className="ak-stack" style={{ gap: 6 }}>
        {cfg.relay.relays.map((url, i) => (
          <div key={`${url}-${i}`} className="ak-row" style={{ gap: 4 }}>
            <input value={url} readOnly className="ak-input ak-input-mono" style={{ flex: 1, fontSize: 11 }} />
            <button className="ak-btn ak-btn-ghost" onClick={() => reorderRelay(i, Math.max(0, i - 1))} disabled={i === 0} title="Move up" style={{ padding: '4px 8px' }}>↑</button>
            <button className="ak-btn ak-btn-ghost" onClick={() => reorderRelay(i, Math.min(cfg.relay.relays.length - 1, i + 1))} disabled={i === cfg.relay.relays.length - 1} title="Move down" style={{ padding: '4px 8px' }}>↓</button>
            <button className="ak-btn ak-btn-ghost" onClick={() => removeRelay(i)} title="Remove" style={{ padding: '4px 8px', color: 'var(--ak-danger)' }}>✕</button>
          </div>
        ))}
      </div>
      <div className="ak-row" style={{ gap: 6 }}>
        <input
          className="ak-input ak-input-mono"
          placeholder="https://relay.example.com:4433/moq"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1, fontSize: 11 }}
        />
        <button
          className="ak-btn ak-btn-primary"
          onClick={() => {
            const t = draft.trim();
            if (!t) return;
            addRelay(t);
            setDraft('');
          }}
        >
          Add
        </button>
      </div>
      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>Draft version</div>
        <select
          className="ak-select"
          value={cfg.relay.draft}
          onChange={(e) => setRelay({ draft: e.target.value as 'draft-16' | 'draft-18' })}
        >
          <option value="draft-16">draft-16</option>
          <option value="draft-18">draft-18</option>
        </select>
      </label>
      <NumberField
        label="Keep-alive"
        value={cfg.relay.keepAliveMs}
        min={0}
        max={60_000}
        step={1000}
        suffix="ms"
        onChange={(v) => setRelay({ keepAliveMs: v })}
      />
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Auto-reconnect on error</div>
        <Toggle checked={cfg.relay.autoReconnect} onChange={(v) => setRelay({ autoReconnect: v })} />
      </div>
    </div>
  );
}

function PublisherCard() {
  const cfg = useTransportConfig();
  const { setPublisher } = useTransportActions();
  return (
    <div className="ak-settings-card">
      <CardHeader title="Publisher" hint="Delivery mode & priority" />
      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>Delivery mode</div>
        <select
          className="ak-select"
          value={cfg.publisher.deliveryMode}
          onChange={(e) => setPublisher({ deliveryMode: e.target.value as 'stream' | 'datagram' })}
        >
          <option value="datagram">Datagram (unreliable)</option>
          <option value="stream">Stream (reliable)</option>
        </select>
      </label>
      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>Group order</div>
        <select
          className="ak-select"
          value={cfg.publisher.groupOrder}
          onChange={(e) => setPublisher({ groupOrder: e.target.value as 'ascending' | 'descending' })}
        >
          <option value="ascending">Ascending (live)</option>
          <option value="descending">Descending (rewind)</option>
        </select>
      </label>
      <NumberField label="Publisher priority" value={cfg.publisher.publisherPriority} min={0} max={255} step={1} onChange={(v) => setPublisher({ publisherPriority: v })} />
      <NumberField label="Object delivery timeout" value={cfg.publisher.objectDeliveryTimeoutMs ?? 0} min={0} max={10_000} step={50} suffix="ms (0=off)" onChange={(v) => setPublisher({ objectDeliveryTimeoutMs: v === 0 ? undefined : v })} />
      <NumberField label="Max cache duration" value={cfg.publisher.maxCacheDurationMs ?? 0} min={0} max={600_000} step={1000} suffix="ms" onChange={(v) => setPublisher({ maxCacheDurationMs: v === 0 ? undefined : v })} />
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Stream per group</div>
        <Toggle checked={cfg.publisher.streamPerGroup} onChange={(v) => setPublisher({ streamPerGroup: v })} disabled={cfg.publisher.deliveryMode !== 'stream'} />
      </div>
    </div>
  );
}

function SubscriberCard() {
  const cfg = useTransportConfig();
  const { setSubscriber } = useTransportActions();
  return (
    <div className="ak-settings-card">
      <CardHeader title="Subscriber" hint="Filter, priority, NGR" />
      <label>
        <div className="ak-caption" style={{ marginBottom: 4 }}>Filter</div>
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
        <div className="ak-caption" style={{ marginBottom: 4 }}>Group order</div>
        <select
          className="ak-select"
          value={cfg.subscriber.groupOrder}
          onChange={(e) => setSubscriber({ groupOrder: e.target.value as never })}
        >
          <option value="ascending">Ascending (live)</option>
          <option value="descending">Descending (rewind)</option>
        </select>
      </label>
      <NumberField label="Subscriber priority" value={cfg.subscriber.subscriberPriority} min={0} max={255} step={1} onChange={(v) => setSubscriber({ subscriberPriority: v })} />
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Forward objects (forward=1)</div>
        <Toggle checked={cfg.subscriber.forward} onChange={(v) => setSubscriber({ forward: v })} />
      </div>
      <div className="ak-row-between">
        <div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>Request new group on join</div>
          <div className="ak-caption" style={{ marginTop: 2 }}>Draft-18 §10.2.13 NGR</div>
        </div>
        <Toggle checked={cfg.subscriber.requestNewGroupOnJoin} onChange={(v) => setSubscriber({ requestNewGroupOnJoin: v })} />
      </div>
    </div>
  );
}

function PlaybackCard() {
  const cfg = useTransportConfig();
  const { setPlayback } = useTransportActions();
  const p = cfg.playback;
  return (
    <div className="ak-settings-card">
      <CardHeader title="Playback" hint="Jitter, catch-up, deadlines" />
      <NumberField label="Jitter buffer" value={p.jitterBufferDelay} min={0} max={3000} step={10} suffix="ms" onChange={(v) => setPlayback({ jitterBufferDelay: v })} />
      <NumberField label="Max latency" value={p.maxLatency === Infinity ? 10_000 : p.maxLatency} min={0} max={10_000} step={50} suffix="ms" onChange={(v) => setPlayback({ maxLatency: v })} />
      <NumberField label="Estimated GOP" value={p.estimatedGopDuration} min={100} max={5000} step={100} suffix="ms" onChange={(v) => setPlayback({ estimatedGopDuration: v })} />
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Latency deadline</div>
        <Toggle checked={p.useLatencyDeadline} onChange={(v) => setPlayback({ useLatencyDeadline: v })} />
      </div>
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Skip to latest group</div>
        <Toggle checked={p.skipToLatestGroup} onChange={(v) => setPlayback({ skipToLatestGroup: v })} />
      </div>
      <div className="ak-row-between">
        <div className="ak-subtle" style={{ fontSize: 12 }}>Catch-up mode</div>
        <Toggle checked={p.enableCatchUp} onChange={(v) => setPlayback({ enableCatchUp: v })} />
      </div>
    </div>
  );
}

function NumberField({
  label, value, min, max, step, suffix, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label>
      <div className="ak-caption" style={{ marginBottom: 4 }}>
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
