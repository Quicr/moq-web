// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import { useMemo, useState } from 'react';
import {
  createCatalog,
  serializeCatalog,
  type AudioTrackInput,
  type FullCatalog,
  type VideoTrackInput,
} from '@moq-web/msf';
import { GlassPanel } from '../shell/GlassPanel.js';
import { Toggle } from '../shell/Toggle.js';

type Role = 'video' | 'audio';

interface VideoDraft {
  kind: 'video';
  id: string;
  name: string;
  codec: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  isLive: boolean;
  label?: string;
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  initData?: string;
  temporalId?: number;
  spatialId?: number;
}

interface AudioDraft {
  kind: 'audio';
  id: string;
  name: string;
  codec: string;
  samplerate: number;
  channelConfig: 'mono' | 'stereo' | 'surround-5.1' | 'surround-7.1' | 'atmos';
  bitrate: number;
  isLive: boolean;
  label?: string;
  lang?: string;
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  audioSpecificConfig?: string;
}

type TrackDraft = VideoDraft | AudioDraft;

interface CatalogFormState {
  generatedAt: boolean;
  isComplete: boolean;
  encryption: {
    enabled: boolean;
    scheme: string;
    cipherSuite: 'aes-128-gcm-sha256' | 'aes-256-gcm-sha512' | 'aes-128-ctr-hmac-sha256-80';
    keyId: string;
    trackBaseKey: string;
  };
  accessibility: {
    enabled: boolean;
    caption: boolean;
    signLanguage: boolean;
    audioDescription: boolean;
    subtitle: boolean;
  };
}

let uidCounter = 0;
const uid = () => `t-${++uidCounter}-${Math.random().toString(36).slice(2, 6)}`;

function defaultVideo(): VideoDraft {
  return {
    kind: 'video',
    id: uid(),
    name: 'video-main',
    codec: 'av01.0.05M.08',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_000_000,
    isLive: true,
  };
}

function defaultAudio(): AudioDraft {
  return {
    kind: 'audio',
    id: uid(),
    name: 'audio-main',
    codec: 'opus',
    samplerate: 48_000,
    channelConfig: 'stereo',
    bitrate: 96_000,
    isLive: true,
    lang: 'en',
  };
}

export interface MsfCatalogBuilderProps {
  onPublish: (catalog: FullCatalog, serialized: string) => void | Promise<void>;
  title?: string;
  initialTracks?: TrackDraft[];
}

/**
 * Full MSF catalog builder — supports adding/removing video + audio tracks
 * with every reserved track field, plus catalog-level flags (generatedAt,
 * isComplete), catalog-wide encryption, and accessibility roles.
 *
 * Emits a `FullCatalog` and its JSON serialization on publish.
 */
export function MsfCatalogBuilder({
  onPublish,
  title = 'MSF catalog builder',
  initialTracks,
}: MsfCatalogBuilderProps) {
  const [tracks, setTracks] = useState<TrackDraft[]>(
    () => initialTracks ?? [defaultVideo(), defaultAudio()],
  );
  const [form, setForm] = useState<CatalogFormState>({
    generatedAt: true,
    isComplete: false,
    encryption: {
      enabled: false,
      scheme: 'moq-secure-objects',
      cipherSuite: 'aes-128-gcm-sha256',
      keyId: '',
      trackBaseKey: '',
    },
    accessibility: {
      enabled: false,
      caption: false,
      signLanguage: false,
      audioDescription: false,
      subtitle: false,
    },
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalog = useMemo(() => buildCatalog(tracks, form), [tracks, form]);
  const preview = useMemo(() => {
    try {
      return serializeCatalog(catalog);
    } catch (err) {
      return `// ${(err as Error).message}`;
    }
  }, [catalog]);

  const addTrack = (kind: Role) => {
    setTracks((cur) => [...cur, kind === 'video' ? defaultVideo() : defaultAudio()]);
  };

  const removeTrack = (id: string) => {
    setTracks((cur) => cur.filter((t) => t.id !== id));
  };

  const updateTrack = (id: string, patch: Record<string, unknown>) => {
    setTracks((cur) => cur.map((t) => (t.id === id ? ({ ...t, ...patch } as TrackDraft) : t)));
  };

  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 14 }}>
        <div>
          <div className="ak-heading">{title}</div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>
            Full MSF §5–§6 catalog: tracks, encryption, accessibility.
          </div>
        </div>
        <div className="ak-row" style={{ gap: 6 }}>
          {status && <span className="ak-chip ak-chip-success">{status}</span>}
          {error && <span className="ak-chip ak-chip-danger">{error}</span>}
        </div>
      </div>

      <div className="ak-stack" style={{ gap: 14 }}>
        <div className="ak-settings-card">
          <div className="ak-caption">Catalog metadata</div>
          <div className="ak-row-between">
            <div className="ak-subtle" style={{ fontSize: 12 }}>Include generatedAt timestamp</div>
            <Toggle
              checked={form.generatedAt}
              onChange={(v) => setForm((s) => ({ ...s, generatedAt: v }))}
            />
          </div>
          <div className="ak-row-between">
            <div>
              <div className="ak-subtle" style={{ fontSize: 12 }}>Mark isComplete</div>
              <div className="ak-caption" style={{ marginTop: 2 }}>
                §5.6 one-way latch — no more tracks after this catalog
              </div>
            </div>
            <Toggle
              checked={form.isComplete}
              onChange={(v) => setForm((s) => ({ ...s, isComplete: v }))}
            />
          </div>
        </div>

        <EncryptionCard
          state={form.encryption}
          onChange={(patch) => setForm((s) => ({ ...s, encryption: { ...s.encryption, ...patch } }))}
        />

        <AccessibilityCard
          state={form.accessibility}
          onChange={(patch) => setForm((s) => ({ ...s, accessibility: { ...s.accessibility, ...patch } }))}
        />

        <div className="ak-row" style={{ gap: 8 }}>
          <button className="ak-btn" onClick={() => addTrack('video')}>+ Video track</button>
          <button className="ak-btn" onClick={() => addTrack('audio')}>+ Audio track</button>
        </div>

        {tracks.map((t) => (
          <TrackCard
            key={t.id}
            track={t}
            onChange={(patch) => updateTrack(t.id, patch)}
            onRemove={() => removeTrack(t.id)}
            canRemove={tracks.length > 1}
          />
        ))}

        <details className="ak-settings-card">
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Catalog JSON preview ({preview.length} chars)
          </summary>
          <pre style={{ margin: 0, fontSize: 11, maxHeight: 260, overflow: 'auto' }}>
            {preview}
          </pre>
        </details>
      </div>

      <div className="ak-row" style={{ marginTop: 20, justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="ak-btn ak-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(null);
            setError(null);
            try {
              await onPublish(catalog, preview);
              setStatus('published');
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Publishing…' : 'Publish catalog'}
        </button>
      </div>
    </GlassPanel>
  );
}

function buildCatalog(tracks: TrackDraft[], form: CatalogFormState): FullCatalog {
  const b = createCatalog();
  if (form.generatedAt) b.generatedAt();
  if (form.isComplete) b.isComplete();

  const encExtras =
    form.encryption.enabled
      ? {
          encryptionScheme: form.encryption.scheme,
          cipherSuite: form.encryption.cipherSuite,
          keyId: form.encryption.keyId || undefined,
          trackBaseKey: form.encryption.trackBaseKey || undefined,
        }
      : undefined;

  for (const t of tracks) {
    if (t.kind === 'video') {
      const input: VideoTrackInput = {
        name: t.name,
        codec: t.codec,
        width: t.width,
        height: t.height,
        framerate: t.framerate,
        bitrate: t.bitrate,
        isLive: t.isLive,
        label: t.label || undefined,
        renderGroup: t.renderGroup,
        altGroup: t.altGroup,
        targetLatency: t.targetLatency,
        initData: t.initData || undefined,
        temporalId: t.temporalId,
        spatialId: t.spatialId,
      };
      b.addVideoTrack(input);
    } else {
      const input: AudioTrackInput = {
        name: t.name,
        codec: t.codec,
        samplerate: t.samplerate,
        channelConfig: t.channelConfig,
        bitrate: t.bitrate,
        isLive: t.isLive,
        label: t.label || undefined,
        lang: t.lang || undefined,
        renderGroup: t.renderGroup,
        altGroup: t.altGroup,
        targetLatency: t.targetLatency,
        audioSpecificConfig: t.audioSpecificConfig || undefined,
      };
      b.addAudioTrack(input);
    }
  }

  const catalog = b.build();

  // Layer optional catalog-wide encryption + accessibility onto every track.
  const anyCatalog = catalog as unknown as {
    tracks: Record<string, unknown>[];
  };
  if (encExtras) {
    anyCatalog.tracks = anyCatalog.tracks.map((track) => ({ ...track, ...encExtras }));
  }
  if (form.accessibility.enabled) {
    const acc = accessibilityFromForm(form.accessibility);
    if (acc.length > 0) {
      anyCatalog.tracks = anyCatalog.tracks.map((track, i) => {
        const desc = acc[i % acc.length];
        return desc ? { ...track, accessibility: [desc] } : track;
      });
    }
  }
  return catalog;
}

function accessibilityFromForm(
  a: CatalogFormState['accessibility'],
): { scheme: string; label: string }[] {
  const entries: { scheme: string; label: string }[] = [];
  if (a.caption) entries.push({ scheme: 'urn:scte:dash:cc:cea-608:2015', label: 'caption' });
  if (a.subtitle) entries.push({ scheme: 'urn:scte:dash:cc:cea-708:2015', label: 'subtitle' });
  if (a.audioDescription) entries.push({ scheme: 'urn:mpeg:dash:role:2011', label: 'audiodescription' });
  if (a.signLanguage) entries.push({ scheme: 'urn:mpeg:dash:role:2011', label: 'signlanguage' });
  return entries;
}

function TrackCard({
  track,
  onChange,
  onRemove,
  canRemove,
}: {
  track: TrackDraft;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="ak-settings-card">
      <div className="ak-row-between">
        <div>
          <div className="ak-caption">{track.kind === 'video' ? 'Video track' : 'Audio track'}</div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{track.name}</div>
        </div>
        <div className="ak-row" style={{ gap: 6 }}>
          <Toggle checked={track.isLive} onChange={(v) => onChange({ isLive: v })} />
          <span className="ak-subtle" style={{ fontSize: 11 }}>live</span>
          {canRemove && (
            <button className="ak-btn ak-btn-ghost" onClick={onRemove} style={{ color: 'var(--ak-danger)' }}>
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="ak-grid-2">
        <Text label="Track name" value={track.name} onChange={(v) => onChange({ name: v })} />
        <Text label="Codec" value={track.codec} onChange={(v) => onChange({ codec: v })} />
        {track.kind === 'video' ? (
          <>
            <Num label="Width" value={track.width} onChange={(v) => onChange({ width: v })} />
            <Num label="Height" value={track.height} onChange={(v) => onChange({ height: v })} />
            <Num label="Framerate" value={track.framerate} onChange={(v) => onChange({ framerate: v })} />
            <Num label="Bitrate (bps)" value={track.bitrate} onChange={(v) => onChange({ bitrate: v })} />
            <Num
              label="Temporal ID"
              value={track.temporalId ?? 0}
              onChange={(v) => onChange({ temporalId: v || undefined })}
            />
            <Num
              label="Spatial ID"
              value={track.spatialId ?? 0}
              onChange={(v) => onChange({ spatialId: v || undefined })}
            />
          </>
        ) : (
          <>
            <Num label="Samplerate" value={track.samplerate} onChange={(v) => onChange({ samplerate: v })} />
            <Num label="Bitrate (bps)" value={track.bitrate} onChange={(v) => onChange({ bitrate: v })} />
            <Select
              label="Channel config"
              value={track.channelConfig}
              options={['mono', 'stereo', 'surround-5.1', 'surround-7.1', 'atmos']}
              onChange={(v) => onChange({ channelConfig: v as AudioDraft['channelConfig'] })}
            />
            <Text
              label="Language (BCP 47)"
              value={track.lang ?? ''}
              onChange={(v) => onChange({ lang: v || undefined })}
            />
            <Text
              label="AudioSpecificConfig (base64)"
              value={track.audioSpecificConfig ?? ''}
              onChange={(v) => onChange({ audioSpecificConfig: v || undefined })}
            />
          </>
        )}
        <Text
          label="Label"
          value={track.label ?? ''}
          onChange={(v) => onChange({ label: v || undefined })}
        />
        <Num
          label="Render group"
          value={track.renderGroup ?? 0}
          onChange={(v) => onChange({ renderGroup: v || undefined })}
        />
        <Num
          label="Alt group"
          value={track.altGroup ?? 0}
          onChange={(v) => onChange({ altGroup: v || undefined })}
        />
        <Num
          label="Target latency (ms)"
          value={track.targetLatency ?? 0}
          onChange={(v) => onChange({ targetLatency: v || undefined })}
        />
      </div>
    </div>
  );
}

function EncryptionCard({
  state,
  onChange,
}: {
  state: CatalogFormState['encryption'];
  onChange: (patch: Partial<CatalogFormState['encryption']>) => void;
}) {
  return (
    <div className="ak-settings-card">
      <div className="ak-row-between">
        <div>
          <div className="ak-caption">Encryption (§3)</div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>
            Applied to every track in the catalog
          </div>
        </div>
        <Toggle checked={state.enabled} onChange={(v) => onChange({ enabled: v })} />
      </div>
      {state.enabled && (
        <div className="ak-grid-2">
          <Text label="Scheme" value={state.scheme} onChange={(v) => onChange({ scheme: v })} />
          <Select
            label="Cipher suite"
            value={state.cipherSuite}
            options={['aes-128-gcm-sha256', 'aes-256-gcm-sha512', 'aes-128-ctr-hmac-sha256-80']}
            onChange={(v) => onChange({ cipherSuite: v as CatalogFormState['encryption']['cipherSuite'] })}
          />
          <Text label="Key ID (base64)" value={state.keyId} onChange={(v) => onChange({ keyId: v })} />
          <Text
            label="Track base key (base64)"
            value={state.trackBaseKey}
            onChange={(v) => onChange({ trackBaseKey: v })}
          />
        </div>
      )}
    </div>
  );
}

function AccessibilityCard({
  state,
  onChange,
}: {
  state: CatalogFormState['accessibility'];
  onChange: (patch: Partial<CatalogFormState['accessibility']>) => void;
}) {
  return (
    <div className="ak-settings-card">
      <div className="ak-row-between">
        <div>
          <div className="ak-caption">Accessibility (§16)</div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>
            Assigns roles across tracks in a round-robin
          </div>
        </div>
        <Toggle checked={state.enabled} onChange={(v) => onChange({ enabled: v })} />
      </div>
      {state.enabled && (
        <div className="ak-grid-2">
          <ToggleRow label="Caption" checked={state.caption} onChange={(v) => onChange({ caption: v })} />
          <ToggleRow label="Subtitle" checked={state.subtitle} onChange={(v) => onChange({ subtitle: v })} />
          <ToggleRow label="Audio description" checked={state.audioDescription} onChange={(v) => onChange({ audioDescription: v })} />
          <ToggleRow label="Sign language" checked={state.signLanguage} onChange={(v) => onChange({ signLanguage: v })} />
        </div>
      )}
    </div>
  );
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label>
      <div className="ak-caption" style={{ marginBottom: 4 }}>{label}</div>
      <input className="ak-input" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label>
      <div className="ak-caption" style={{ marginBottom: 4 }}>{label}</div>
      <input
        className="ak-input"
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Select({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label>
      <div className="ak-caption" style={{ marginBottom: 4 }}>{label}</div>
      <select className="ak-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="ak-row-between">
      <div className="ak-subtle" style={{ fontSize: 12 }}>{label}</div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
