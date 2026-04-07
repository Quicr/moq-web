// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Add/Edit Track Modal
 *
 * Modal dialog for adding or editing tracks in the catalog builder.
 * Supports VOD, live video, audio, subtitle, and timeline track types.
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
          duration: 0, // Will be set when video is loaded
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold">
            {isEditing ? 'Edit' : 'Add'} {TRACK_TYPE_LABELS[type]} Track
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
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
                <p className="text-xs text-gray-500 mt-1">
                  URL to MP4/WebM video file (must support CORS)
                </p>
              </div>

              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enableDvr}
                    onChange={(e) => setEnableDvr(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm">Enable DVR (seeking)</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={loopPlayback}
                    onChange={(e) => setLoopPlayback(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm">Loop playback</span>
                </label>
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
              <p className="text-xs text-gray-500 mt-1">
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
                return (
                  <label
                    key={profile}
                    className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                      experienceProfile === profile
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="experienceProfile"
                      value={profile}
                      checked={experienceProfile === profile}
                      onChange={() => setExperienceProfile(profile)}
                      className="mt-1"
                    />
                    <div>
                      <div className="font-medium text-sm">{info.label}</div>
                      <div className="text-xs text-gray-500">
                        {info.description} ({info.targetLatency})
                      </div>
                    </div>
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
              <p className="text-xs text-gray-500 mt-1">
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
              <p className="text-xs text-gray-500 mt-1">
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
        <div className="flex justify-end gap-3 p-4 border-t border-gray-200 dark:border-gray-700">
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
