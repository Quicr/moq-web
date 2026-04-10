// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Add/Edit Track Modal
 *
 * Modal dialog for adding or editing tracks in the catalog builder.
 * Glassmorphic design with frosted overlay.
 */

import React, { useState, useEffect } from 'react';
import type {
  CatalogTrackConfig,
  CatalogTrackType,
  VODTrackConfig,
  LiveTrackConfig,
  AudioTrackConfig,
  SubtitleTrackConfig,
  TimelineTrackConfig,
} from './types';
import { DEFAULT_TRACK_CONFIGS, EXPERIENCE_PROFILE_INFO } from './types';
import type { CatalogExperienceProfile } from './types';

interface AddTrackModalProps {
  type: CatalogTrackType;
  existingTrack: CatalogTrackConfig | null;
  onSave: (config: Partial<CatalogTrackConfig>) => void;
  onClose: () => void;
}

const TRACK_TYPE_LABELS: Record<CatalogTrackType, string> = {
  'video-vod': 'VOD Video',
  'video-live': 'Live Video',
  'audio': 'Audio',
  'subtitle': 'Subtitle',
  'timeline': 'Media Timeline',
};

const TRACK_TYPE_ICONS: Record<CatalogTrackType, string> = {
  'video-vod': 'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z',
  'video-live': 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  'audio': 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z',
  'subtitle': 'M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z',
  'timeline': 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
};

export const AddTrackModal: React.FC<AddTrackModalProps> = ({
  type,
  existingTrack,
  onSave,
  onClose,
}) => {
  const isEditing = !!existingTrack;
  const defaults = DEFAULT_TRACK_CONFIGS[type];

  // Common fields
  const [name, setName] = useState(existingTrack?.name || '');
  const [experienceProfile, setExperienceProfile] = useState<CatalogExperienceProfile>(
    existingTrack?.experienceProfile || defaults.experienceProfile
  );
  const [renderGroup, setRenderGroup] = useState(existingTrack?.renderGroup ?? 1);
  const [altGroup, setAltGroup] = useState(existingTrack?.altGroup ?? undefined);
  const [label, setLabel] = useState(existingTrack?.label || '');

  // VOD-specific fields
  const [videoUrl, setVideoUrl] = useState((existingTrack as VODTrackConfig)?.videoUrl || '');
  const [enableDvr, setEnableDvr] = useState((existingTrack as VODTrackConfig)?.enableDvr ?? true);
  const [loopPlayback, setLoopPlayback] = useState((existingTrack as VODTrackConfig)?.loopPlayback ?? false);

  // Video fields (VOD & Live)
  const [codec, setCodec] = useState(
    (existingTrack as VODTrackConfig | LiveTrackConfig)?.codec ||
    (defaults as { codec?: string }).codec || 'avc1.42E01F'
  );
  const [width, setWidth] = useState(
    (existingTrack as VODTrackConfig | LiveTrackConfig)?.width ||
    (defaults as { width?: number }).width || 1280
  );
  const [height, setHeight] = useState(
    (existingTrack as VODTrackConfig | LiveTrackConfig)?.height ||
    (defaults as { height?: number }).height || 720
  );
  const [framerate, setFramerate] = useState(
    (existingTrack as VODTrackConfig | LiveTrackConfig)?.framerate ||
    (defaults as { framerate?: number }).framerate || 30
  );
  const [bitrate, setBitrate] = useState(
    (existingTrack as VODTrackConfig | LiveTrackConfig | AudioTrackConfig)?.bitrate ||
    (defaults as { bitrate?: number }).bitrate || 2_000_000
  );

  // Audio-specific fields
  const [samplerate, setSamplerate] = useState(
    (existingTrack as AudioTrackConfig)?.samplerate ||
    (defaults as { samplerate?: number }).samplerate || 48000
  );
  const [channelConfig, setChannelConfig] = useState<'mono' | 'stereo'>(
    (existingTrack as AudioTrackConfig)?.channelConfig ||
    (defaults as { channelConfig?: 'mono' | 'stereo' }).channelConfig || 'stereo'
  );

  // Subtitle-specific fields
  const [language, setLanguage] = useState(
    (existingTrack as SubtitleTrackConfig)?.language ||
    (defaults as { language?: string }).language || 'en'
  );
  const [subtitleFormat, setSubtitleFormat] = useState<'webvtt' | 'srt'>(
    (existingTrack as SubtitleTrackConfig)?.format ||
    (defaults as { format?: 'webvtt' | 'srt' }).format || 'webvtt'
  );
  const [subtitleLabel, setSubtitleLabel] = useState(
    (existingTrack as SubtitleTrackConfig)?.label ||
    (defaults as { label?: string }).label || 'English'
  );

  // Timeline-specific fields
  const [timescale, setTimescale] = useState(
    (existingTrack as TimelineTrackConfig)?.timescale ||
    (defaults as { timescale?: number }).timescale || 1000
  );

  // Generate default name based on type
  useEffect(() => {
    if (!isEditing && !name) {
      const prefix = {
        'video-vod': 'vod-video',
        'video-live': 'live-video',
        'audio': 'audio',
        'subtitle': 'subtitles',
        'timeline': 'timeline',
      }[type];
      setName(prefix);
    }
  }, [type, isEditing, name]);

  const handleSave = () => {
    const baseConfig: Partial<CatalogTrackConfig> = {
      name,
      experienceProfile,
      renderGroup: renderGroup || undefined,
      altGroup: altGroup || undefined,
      label: label || undefined,
    };

    switch (type) {
      case 'video-vod':
        onSave({
          ...baseConfig,
          videoUrl,
          codec,
          width,
          height,
          framerate,
          bitrate,
          enableDvr,
          loopPlayback,
          duration: 0,
        } as Partial<VODTrackConfig>);
        break;

      case 'video-live':
        onSave({
          ...baseConfig,
          codec,
          width,
          height,
          framerate,
          bitrate,
        } as Partial<LiveTrackConfig>);
        break;

      case 'audio':
        onSave({
          ...baseConfig,
          codec: 'opus',
          samplerate,
          channelConfig,
          bitrate,
        } as Partial<AudioTrackConfig>);
        break;

      case 'subtitle':
        onSave({
          ...baseConfig,
          language,
          format: subtitleFormat,
          label: subtitleLabel,
        } as Partial<SubtitleTrackConfig>);
        break;

      case 'timeline':
        onSave({
          ...baseConfig,
          timescale,
        } as Partial<TimelineTrackConfig>);
        break;
    }
  };

  // Checkbox component
  const Checkbox: React.FC<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
  }> = ({ checked, onChange, label }) => (
    <label className="flex items-center gap-2 cursor-pointer group">
      <div
        className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${
          checked
            ? 'bg-gradient-to-r from-accent-purple to-primary-500 border-transparent'
            : 'border-white/20 bg-white/5 group-hover:border-white/30'
        }`}
        onClick={() => onChange(!checked)}
      >
        {checked && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <span className="text-sm text-tertiary">{label}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 glass-panel-glow w-full max-w-lg max-h-[90vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple/30 to-primary-500/30 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={TRACK_TYPE_ICONS[type]} />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-primary">
              {isEditing ? 'Edit' : 'Add'} {TRACK_TYPE_LABELS[type]} Track
            </h2>
          </div>
          <button
            onClick={onClose}
            className="btn-icon btn-ghost"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {/* Common: Track Name */}
          <div>
            <label className="label">Track Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., video, audio, en-subtitles"
              className="input"
            />
          </div>

          {/* VOD: Video URL */}
          {type === 'video-vod' && (
            <>
              <div>
                <label className="label">Video URL</label>
                <input
                  type="url"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  placeholder="https://example.com/video.mp4"
                  className="input"
                />
                <p className="text-xs text-subtle mt-2">
                  URL to MP4/WebM video file (must support CORS)
                </p>
              </div>

              <div className="flex gap-6">
                <Checkbox
                  checked={enableDvr}
                  onChange={setEnableDvr}
                  label="Enable DVR (seeking)"
                />
                <Checkbox
                  checked={loopPlayback}
                  onChange={setLoopPlayback}
                  label="Loop playback"
                />
              </div>
            </>
          )}

          {/* Video fields (VOD & Live) */}
          {(type === 'video-vod' || type === 'video-live') && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Resolution</label>
                  <select
                    value={`${width}x${height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split('x').map(Number);
                      setWidth(w);
                      setHeight(h);
                    }}
                    className="input"
                  >
                    <option value="3840x2160">4K UHD (3840x2160)</option>
                    <option value="2560x1440">1440p QHD (2560x1440)</option>
                    <option value="1920x1080">1080p (1920x1080)</option>
                    <option value="1280x720">720p (1280x720)</option>
                    <option value="854x480">480p (854x480)</option>
                    <option value="640x360">360p (640x360)</option>
                  </select>
                </div>
                <div>
                  <label className="label">Framerate</label>
                  <select
                    value={framerate}
                    onChange={(e) => setFramerate(Number(e.target.value))}
                    className="input"
                  >
                    <option value={60}>60 fps</option>
                    <option value={30}>30 fps</option>
                    <option value={24}>24 fps</option>
                    <option value={15}>15 fps</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Codec</label>
                  <select
                    value={codec}
                    onChange={(e) => setCodec(e.target.value)}
                    className="input"
                  >
                    <option value="avc1.42E01F">H.264 Baseline</option>
                    <option value="avc1.4D401E">H.264 Main</option>
                    <option value="avc1.640033">H.264 High (4K)</option>
                    <option value="vp09.00.10.08">VP9</option>
                    <option value="av01.0.08M.10">AV1</option>
                  </select>
                </div>
                <div>
                  <label className="label">Bitrate</label>
                  <select
                    value={bitrate}
                    onChange={(e) => setBitrate(Number(e.target.value))}
                    className="input"
                  >
                    <option value={25_000_000}>25 Mbps (4K)</option>
                    <option value={15_000_000}>15 Mbps (4K/1440p)</option>
                    <option value={8_000_000}>8 Mbps</option>
                    <option value={4_000_000}>4 Mbps</option>
                    <option value={2_000_000}>2 Mbps</option>
                    <option value={1_000_000}>1 Mbps</option>
                    <option value={500_000}>500 Kbps</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {/* Audio fields */}
          {type === 'audio' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Sample Rate</label>
                  <select
                    value={samplerate}
                    onChange={(e) => setSamplerate(Number(e.target.value))}
                    className="input"
                  >
                    <option value={48000}>48 kHz</option>
                    <option value={44100}>44.1 kHz</option>
                    <option value={32000}>32 kHz</option>
                    <option value={16000}>16 kHz</option>
                  </select>
                </div>
                <div>
                  <label className="label">Channels</label>
                  <select
                    value={channelConfig}
                    onChange={(e) => setChannelConfig(e.target.value as 'mono' | 'stereo')}
                    className="input"
                  >
                    <option value="stereo">Stereo</option>
                    <option value="mono">Mono</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Bitrate</label>
                <select
                  value={bitrate}
                  onChange={(e) => setBitrate(Number(e.target.value))}
                  className="input"
                >
                  <option value={256_000}>256 kbps</option>
                  <option value={128_000}>128 kbps</option>
                  <option value={64_000}>64 kbps</option>
                  <option value={32_000}>32 kbps</option>
                </select>
              </div>
            </>
          )}

          {/* Subtitle fields */}
          {type === 'subtitle' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Language Code</label>
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="en"
                    className="input"
                  />
                </div>
                <div>
                  <label className="label">Format</label>
                  <select
                    value={subtitleFormat}
                    onChange={(e) => setSubtitleFormat(e.target.value as 'webvtt' | 'srt')}
                    className="input"
                  >
                    <option value="webvtt">WebVTT</option>
                    <option value="srt">SRT</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Display Label</label>
                <input
                  type="text"
                  value={subtitleLabel}
                  onChange={(e) => setSubtitleLabel(e.target.value)}
                  placeholder="English"
                  className="input"
                />
              </div>
            </>
          )}

          {/* Timeline fields */}
          {type === 'timeline' && (
            <div>
              <label className="label">Timescale (units per second)</label>
              <select
                value={timescale}
                onChange={(e) => setTimescale(Number(e.target.value))}
                className="input"
              >
                <option value={1000}>1000 (milliseconds)</option>
                <option value={90000}>90000 (MPEG-TS)</option>
                <option value={48000}>48000 (audio samples)</option>
              </select>
              <p className="text-xs text-subtle mt-2">
                Media timeline for seeking in VOD content
              </p>
            </div>
          )}

          {/* Common: Experience Profile */}
          <div>
            <label className="label">Experience Profile</label>
            <div className="space-y-2">
              {(['interactive', 'streaming', 'broadcast'] as CatalogExperienceProfile[]).map((profile) => {
                const info = EXPERIENCE_PROFILE_INFO[profile];
                const isSelected = experienceProfile === profile;
                return (
                  <label
                    key={profile}
                    className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-gradient-to-r from-accent-purple/20 to-primary-500/20 border border-accent-purple/40'
                        : 'bg-white/5 border border-white/5 hover:border-white/10'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all mt-0.5 ${
                        isSelected
                          ? 'border-accent-purple bg-accent-purple'
                          : 'border-white/30'
                      }`}
                    >
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-sm text-secondary">{info.label}</div>
                      <div className="text-xs text-muted mt-0.5">
                        {info.description}
                        <span className="text-accent-cyan ml-1">({info.targetLatency})</span>
                      </div>
                    </div>
                    <input
                      type="radio"
                      name="experienceProfile"
                      value={profile}
                      checked={isSelected}
                      onChange={() => setExperienceProfile(profile)}
                      className="sr-only"
                    />
                  </label>
                );
              })}
            </div>
          </div>

          {/* Common: Groups */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Render Group</label>
              <input
                type="number"
                value={renderGroup}
                onChange={(e) => setRenderGroup(Number(e.target.value))}
                min={1}
                className="input"
              />
              <p className="text-xs text-subtle mt-1">
                Tracks in same group sync together
              </p>
            </div>
            <div>
              <label className="label">Alt Group (ABR)</label>
              <input
                type="number"
                value={altGroup ?? ''}
                onChange={(e) => setAltGroup(e.target.value ? Number(e.target.value) : undefined)}
                min={1}
                placeholder="Optional"
                className="input"
              />
              <p className="text-xs text-subtle mt-1">
                Quality variants share same altGroup
              </p>
            </div>
          </div>

          {/* Common: Label */}
          <div>
            <label className="label">Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Human-readable description"
              className="input"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t border-white/10">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name}
            className="btn-primary"
          >
            {isEditing ? 'Save Changes' : 'Add Track'}
          </button>
        </div>
      </div>
    </div>
  );
};
