// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Settings Panel Component
 *
 * Application settings with tabbed navigation and color-coded sections.
 * Tabs: General, Media, Playback, Security
 */

import React, { useState } from 'react';
import { useStore } from '../../store';
import { LogLevel } from '../../types';
import { VarIntType } from '@web-moq/core';
import {
  EXPERIENCE_PROFILES,
  EXPERIENCE_PROFILE_ORDER,
  type ExperienceProfileName,
} from '@web-moq/media';

// Tab types
type SettingsTab = 'general' | 'media' | 'playback' | 'security';

// Section color schemes
const sectionColors = {
  appearance: { icon: 'text-violet-500', bg: 'bg-violet-100 dark:bg-violet-900/30' },
  developer: { icon: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800/50' },
  video: { icon: 'text-rose-500', bg: 'bg-rose-100 dark:bg-rose-900/30' },
  audio: { icon: 'text-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  vad: { icon: 'text-indigo-500', bg: 'bg-indigo-100 dark:bg-indigo-900/30' },
  network: { icon: 'text-cyan-500', bg: 'bg-cyan-100 dark:bg-cyan-900/30' },
  profile: { icon: 'text-sky-500', bg: 'bg-sky-100 dark:bg-sky-900/30' },
  security: { icon: 'text-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
};

// Icons
const Icons = {
  general: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  ),
  media: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  ),
  playback: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112Z" />
    </svg>
  ),
  security: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
    </svg>
  ),
  appearance: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
    </svg>
  ),
  developer: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  ),
  video: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  ),
  audio: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
    </svg>
  ),
  vad: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
    </svg>
  ),
  network: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z" />
    </svg>
  ),
  profile: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605" />
    </svg>
  ),
  lock: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  ),
  key: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
    </svg>
  ),
  chevronDown: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  ),
  chevronRight: (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  ),
  eyeOpen: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
    </svg>
  ),
  eyeClosed: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  ),
};

// Toggle Switch component
const Toggle: React.FC<{
  enabled: boolean;
  onChange: () => void;
  size?: 'sm' | 'md';
  color?: string;
}> = ({ enabled, onChange, size = 'md', color = 'bg-primary-500' }) => {
  const sizes = {
    sm: { track: 'h-5 w-9', thumb: 'h-3 w-3', translate: 'translate-x-5' },
    md: { track: 'h-6 w-11', thumb: 'h-4 w-4', translate: 'translate-x-6' },
  };
  const s = sizes[size];
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex ${s.track} items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 ${
        enabled ? color : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block ${s.thumb} transform rounded-full bg-white shadow-sm transition-transform ${
          enabled ? s.translate : 'translate-x-1'
        }`}
      />
    </button>
  );
};

// Section Header component with color coding
const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  description?: string;
  colorScheme: { icon: string; bg: string };
}> = ({ icon, title, description, colorScheme }) => (
  <div className="flex items-start gap-3 mb-4">
    <div className={`p-2 rounded-lg ${colorScheme.bg}`}>
      <span className={colorScheme.icon}>{icon}</span>
    </div>
    <div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      {description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      )}
    </div>
  </div>
);

// Collapsible Section component
const CollapsibleSection: React.FC<{
  title: string;
  icon: React.ReactNode;
  colorScheme: { icon: string; bg: string };
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, icon, colorScheme, defaultOpen = false, children }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center gap-3 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <div className={`p-1.5 rounded-md ${colorScheme.bg}`}>
          <span className={colorScheme.icon}>{icon}</span>
        </div>
        <span className="flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <span className={`transform transition-transform text-gray-400 ${isOpen ? 'rotate-180' : ''}`}>
          {Icons.chevronDown}
        </span>
      </button>
      {isOpen && <div className="p-4 border-t border-gray-200 dark:border-gray-700">{children}</div>}
    </div>
  );
};

// Glassmorphism tooltip component
const InfoTip: React.FC<{ text: string; align?: 'left' | 'right' }> = ({ text, align = 'left' }) => {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block ml-1">
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-300/50 dark:bg-gray-500/50 text-gray-600 dark:text-gray-300 text-[10px] cursor-help hover:bg-gray-400/50 dark:hover:bg-gray-400/50 transition-colors"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(!show)}
      >
        ?
      </span>
      {show && (
        <div className={`absolute z-50 bottom-full mb-2 w-56 p-2.5 rounded-lg
          bg-white/95 dark:bg-gray-900/95 backdrop-blur-md
          border border-gray-200/50 dark:border-gray-700/50
          shadow-lg shadow-black/10 dark:shadow-black/30
          text-xs leading-relaxed text-gray-700 dark:text-gray-200 font-medium
          ${align === 'left' ? 'left-0' : 'right-0'}`}>
          {text}
          <div className={`absolute top-full -mt-px ${align === 'left' ? 'left-3' : 'right-3'}`}>
            <div className="border-4 border-transparent border-t-white/95 dark:border-t-gray-900/95" />
          </div>
        </div>
      )}
    </span>
  );
};

// Setting Row component for consistent styling
const SettingRow: React.FC<{
  label: string;
  description?: string;
  tooltip?: string;
  children: React.ReactNode;
}> = ({ label, description, tooltip, children }) => (
  <div className="flex items-center justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
    <div className="flex-1 mr-4">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {tooltip && <InfoTip text={tooltip} />}
      </span>
      {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

export const SettingsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [showFineTune, setShowFineTune] = useState(false);
  const [showBaseKey, setShowBaseKey] = useState(false);

  const {
    theme,
    setTheme,
    logLevel,
    setLogLevel,
    videoBitrate,
    setVideoBitrate,
    audioBitrate,
    setAudioBitrate,
    videoResolution,
    setVideoResolution,
    useAnnounceFlow,
    setUseAnnounceFlow,
    connectionTimeout,
    setConnectionTimeout,
    enableStats,
    setEnableStats,
    jitterBufferDelay,
    setJitterBufferDelay,
    varIntType,
    setVarIntType,
    vadEnabled,
    setVadEnabled,
    vadProvider,
    setVadProvider,
    vadVisualizationEnabled,
    setVadVisualizationEnabled,
    policyType,
    setPolicyType,
    maxLatency,
    setMaxLatency,
    estimatedGopDuration,
    setEstimatedGopDuration,
    skipToLatestGroup,
    setSkipToLatestGroup,
    skipGraceFrames,
    setSkipGraceFrames,
    enableCatchUp,
    setEnableCatchUp,
    catchUpThreshold,
    setCatchUpThreshold,
    useLatencyDeadline,
    setUseLatencyDeadline,
    arbiterDebug,
    setArbiterDebug,
    experienceProfile,
    applyExperienceProfile,
    secureObjectsEnabled,
    setSecureObjectsEnabled,
    secureObjectsCipherSuite,
    setSecureObjectsCipherSuite,
    secureObjectsBaseKey,
    setSecureObjectsBaseKey,
    quicrInteropEnabled,
    setQuicrInteropEnabled,
    quicrParticipantId,
    setQuicrParticipantId,
    vodPublishEnabled,
    setVodPublishEnabled,
  } = useStore();

  // Check if current settings differ from the selected profile
  const isModified = React.useMemo(() => {
    if (experienceProfile === 'custom') return false;
    const profile = EXPERIENCE_PROFILES[experienceProfile];
    if (!profile) return false;
    const s = profile.settings;
    return (
      jitterBufferDelay !== s.jitterBufferDelay ||
      useLatencyDeadline !== s.useLatencyDeadline ||
      maxLatency !== s.maxLatency ||
      estimatedGopDuration !== s.estimatedGopDuration ||
      skipToLatestGroup !== s.skipToLatestGroup ||
      skipGraceFrames !== s.skipGraceFrames ||
      enableCatchUp !== s.enableCatchUp ||
      catchUpThreshold !== s.catchUpThreshold
    );
  }, [
    experienceProfile,
    jitterBufferDelay,
    useLatencyDeadline,
    maxLatency,
    estimatedGopDuration,
    skipToLatestGroup,
    skipGraceFrames,
    enableCatchUp,
    catchUpThreshold,
  ]);

  const handleProfileChange = (profileName: ExperienceProfileName) => {
    applyExperienceProfile(profileName);
    if (profileName !== 'custom') {
      setShowFineTune(false);
    }
  };

  // Profile accent colors (semantic: urgency spectrum from red to gray)
  const profileColors: Record<string, { border: string; bg: string; text: string; badge: string; dot: string }> = {
    'ultra-low': {
      border: 'border-l-red-500',
      bg: 'bg-red-50 dark:bg-red-900/20',
      text: 'text-red-700 dark:text-red-300',
      badge: 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300',
      dot: 'bg-red-500',
    },
    'interactive': {
      border: 'border-l-orange-500',
      bg: 'bg-orange-50 dark:bg-orange-900/20',
      text: 'text-orange-700 dark:text-orange-300',
      badge: 'bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300',
      dot: 'bg-orange-500',
    },
    'low-latency-live': {
      border: 'border-l-yellow-500',
      bg: 'bg-yellow-50 dark:bg-yellow-900/20',
      text: 'text-yellow-700 dark:text-yellow-300',
      badge: 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300',
      dot: 'bg-yellow-500',
    },
    'live-streaming': {
      border: 'border-l-green-500',
      bg: 'bg-green-50 dark:bg-green-900/20',
      text: 'text-green-700 dark:text-green-300',
      badge: 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300',
      dot: 'bg-green-500',
    },
    'broadcast': {
      border: 'border-l-slate-500',
      bg: 'bg-slate-100 dark:bg-slate-800/50',
      text: 'text-slate-700 dark:text-slate-300',
      badge: 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300',
      dot: 'bg-slate-500',
    },
    'vod': {
      border: 'border-l-indigo-500',
      bg: 'bg-indigo-50 dark:bg-indigo-900/20',
      text: 'text-indigo-700 dark:text-indigo-300',
      badge: 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300',
      dot: 'bg-indigo-500',
    },
    'custom': {
      border: 'border-l-purple-500',
      bg: 'bg-purple-50 dark:bg-purple-900/20',
      text: 'text-purple-700 dark:text-purple-300',
      badge: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
      dot: 'bg-purple-500',
    },
  };

  // Tab configuration with colors
  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode; color: string }[] = [
    { id: 'general', label: 'General', icon: Icons.general, color: 'violet' },
    { id: 'media', label: 'Media', icon: Icons.media, color: 'rose' },
    { id: 'playback', label: 'Playback', icon: Icons.playback, color: 'sky' },
    { id: 'security', label: 'Security', icon: Icons.security, color: 'emerald' },
  ];

  const tabColors: Record<string, { active: string; hover: string; gradient: string }> = {
    violet: { active: 'text-violet-600 dark:text-violet-400', hover: 'hover:text-violet-600', gradient: 'from-violet-500 to-violet-400' },
    rose: { active: 'text-rose-600 dark:text-rose-400', hover: 'hover:text-rose-600', gradient: 'from-rose-500 to-rose-400' },
    sky: { active: 'text-sky-600 dark:text-sky-400', hover: 'hover:text-sky-600', gradient: 'from-sky-500 to-sky-400' },
    emerald: { active: 'text-emerald-600 dark:text-emerald-400', hover: 'hover:text-emerald-600', gradient: 'from-emerald-500 to-emerald-400' },
  };

  // Fine-tune controls renderer
  const renderFineTuneControls = () => (
    <div className="space-y-4">
      <div>
        <label className="label text-xs">
          Jitter Buffer: {jitterBufferDelay}ms
          <InfoTip text="Wait time before displaying frames. Smooths out network hiccups." />
        </label>
        <input type="range" min="50" max="300" step="10" value={jitterBufferDelay}
          onChange={(e) => setJitterBufferDelay(Number(e.target.value))} className="w-full h-1.5 accent-sky-500" />
      </div>
      <div>
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Interactive Mode
            <InfoTip text="ON: Give up on slow groups quickly. OFF: Be patient, wait longer before skipping." />
          </span>
          <Toggle enabled={useLatencyDeadline} onChange={() => setUseLatencyDeadline(!useLatencyDeadline)} size="sm" color="bg-sky-500" />
        </label>
      </div>
      <div>
        <label className="label text-xs">
          Max Latency: {maxLatency}ms
          <InfoTip text="Maximum time to wait for slow video data before skipping." />
        </label>
        <input type="range" min="0" max="5000" step="50" value={maxLatency}
          onChange={(e) => setMaxLatency(Number(e.target.value))} className="w-full h-1.5 accent-sky-500" />
      </div>
      <div>
        <label className="label text-xs">
          GOP Duration: {estimatedGopDuration}ms
          <InfoTip text="Expected time between keyframes. Match to your encoder's keyframe interval." />
        </label>
        <input type="range" min="100" max="5000" step="100" value={estimatedGopDuration}
          onChange={(e) => setEstimatedGopDuration(Number(e.target.value))} className="w-full h-1.5 accent-sky-500" />
      </div>
      <div>
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Skip to Latest Group
            <InfoTip text="Jump to new keyframes immediately instead of finishing the current group." />
          </span>
          <Toggle enabled={skipToLatestGroup} onChange={() => setSkipToLatestGroup(!skipToLatestGroup)} size="sm" color="bg-sky-500" />
        </label>
      </div>
      {skipToLatestGroup && (
        <div className="ml-4 pl-4 border-l-2 border-sky-200 dark:border-sky-800">
          <label className="label text-xs">Grace Period: {skipGraceFrames} frames</label>
          <input type="range" min="0" max="10" step="1" value={skipGraceFrames}
            onChange={(e) => setSkipGraceFrames(Number(e.target.value))} className="w-full h-1.5 accent-sky-500" />
        </div>
      )}
      <div>
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Buffer Catch-Up
            <InfoTip text="When frames pile up, fast-forward by skipping intermediate frames." />
          </span>
          <Toggle enabled={enableCatchUp} onChange={() => setEnableCatchUp(!enableCatchUp)} size="sm" color="bg-sky-500" />
        </label>
      </div>
      {enableCatchUp && (
        <div className="ml-4 pl-4 border-l-2 border-sky-200 dark:border-sky-800">
          <label className="label text-xs">Catch-Up Threshold: {catchUpThreshold} frames</label>
          <input type="range" min="3" max="15" step="1" value={catchUpThreshold}
            onChange={(e) => setCatchUpThreshold(Number(e.target.value))} className="w-full h-1.5 accent-sky-500" />
        </div>
      )}
      <div className="pt-3 mt-3 border-t border-gray-200 dark:border-gray-700">
        <label className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Debug Logging</span>
          <Toggle enabled={arbiterDebug} onChange={() => setArbiterDebug(!arbiterDebug)} size="sm" color="bg-orange-500" />
        </label>
      </div>
    </div>
  );

  const currentTab = tabs.find(t => t.id === activeTab)!;
  const currentColors = tabColors[currentTab.color];

  return (
    <div className="flex flex-col h-full max-h-[70vh]">
      {/* Tab Navigation */}
      <div className="relative">
        <div className={`absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r ${currentColors.gradient}`} />
        <div className="flex bg-gray-50 dark:bg-gray-800/50">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const colors = tabColors[tab.color];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium transition-all ${
                  isActive
                    ? `${colors.active} bg-white dark:bg-gray-900`
                    : `text-gray-500 ${colors.hover} hover:bg-gray-100 dark:hover:bg-gray-800`
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* General Tab */}
        {activeTab === 'general' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-gradient-to-br from-violet-50 to-white dark:from-violet-900/20 dark:to-gray-900 border border-violet-100 dark:border-violet-900/30">
              <SectionHeader icon={Icons.appearance} title="Appearance" description="Customize the look and feel" colorScheme={sectionColors.appearance} />
              <SettingRow label="Theme">
                <select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')} className="input w-32 text-sm">
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </SettingRow>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-cyan-50 to-white dark:from-cyan-900/20 dark:to-gray-900 border border-cyan-100 dark:border-cyan-900/30">
              <SectionHeader icon={Icons.network} title="Connection" description="Server connection settings" colorScheme={sectionColors.network} />
              <SettingRow label="Connection Timeout" description="Time to wait for connection before giving up">
                <select value={connectionTimeout} onChange={(e) => setConnectionTimeout(Number(e.target.value))} className="input w-32 text-sm">
                  <option value={10000}>10 seconds</option>
                  <option value={30000}>30 seconds</option>
                  <option value={60000}>1 minute</option>
                  <option value={120000}>2 minutes</option>
                  <option value={300000}>5 minutes</option>
                  <option value={600000}>10 minutes</option>
                </select>
              </SettingRow>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-teal-50 to-white dark:from-teal-900/20 dark:to-gray-900 border border-teal-100 dark:border-teal-900/30">
              <SectionHeader icon={Icons.network} title="QuicR Interop" description="Interoperability with quicr-mac native client" colorScheme={sectionColors.network} />
              <div className="space-y-1">
                <SettingRow label="Enable QuicR Mode" description="Use fixed-size LOC extensions for quicr-mac compatibility" tooltip="When enabled, LOC packets use fixed-size immutable extensions instead of VarInt encoding. Required for interop with quicr-mac native client.">
                  <Toggle enabled={quicrInteropEnabled} onChange={() => setQuicrInteropEnabled(!quicrInteropEnabled)} color="bg-teal-500" />
                </SettingRow>
                {quicrInteropEnabled && (
                  <SettingRow label="Participant ID" description="32-bit identifier for this participant">
                    <input
                      type="number"
                      min="0"
                      max="4294967295"
                      value={quicrParticipantId}
                      onChange={(e) => setQuicrParticipantId(Math.min(4294967295, Math.max(0, Number(e.target.value) || 0)))}
                      className="input w-32 text-sm font-mono"
                      placeholder="0"
                    />
                  </SettingRow>
                )}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-slate-50 to-white dark:from-slate-800/30 dark:to-gray-900 border border-slate-200 dark:border-slate-700/50">
              <SectionHeader icon={Icons.developer} title="Developer" description="Debugging and logging options" colorScheme={sectionColors.developer} />
              <SettingRow label="Log Level" description="Control console output verbosity">
                <select value={logLevel} onChange={(e) => setLogLevel(Number(e.target.value) as LogLevel)} className="input w-32 text-sm">
                  <option value={LogLevel.TRACE}>Trace</option>
                  <option value={LogLevel.DEBUG}>Debug</option>
                  <option value={LogLevel.INFO}>Info</option>
                  <option value={LogLevel.WARN}>Warning</option>
                  <option value={LogLevel.ERROR}>Error</option>
                  <option value={LogLevel.SILENT}>Silent</option>
                </select>
              </SettingRow>
            </div>

            <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700/50">
              <div className="text-center text-sm">
                <p className="font-semibold text-gray-900 dark:text-white">MOQT Client</p>
                <p className="text-gray-500 dark:text-gray-400 mt-1">Media over QUIC Transport</p>
                <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-800">
                  <span className="text-xs text-gray-500">v0.1.0</span>
                  <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                  <span className="text-xs font-mono text-gray-400">{import.meta.env.VITE_GIT_COMMIT?.slice(0, 7) || 'dev'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Media Tab */}
        {activeTab === 'media' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-gradient-to-br from-rose-50 to-white dark:from-rose-900/20 dark:to-gray-900 border border-rose-100 dark:border-rose-900/30">
              <SectionHeader icon={Icons.video} title="Video" description="Resolution and bitrate settings" colorScheme={sectionColors.video} />
              <div className="space-y-4">
                <SettingRow label="Resolution">
                  <select value={videoResolution} onChange={(e) => setVideoResolution(e.target.value as '720p' | '1080p' | '480p')} className="input w-40 text-sm">
                    <option value="480p">480p (854x480)</option>
                    <option value="720p">720p (1280x720)</option>
                    <option value="1080p">1080p (1920x1080)</option>
                  </select>
                </SettingRow>
                <div className="pt-2">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Video Bitrate</label>
                    <span className="text-sm font-mono font-semibold text-rose-600 dark:text-rose-400 bg-rose-100 dark:bg-rose-900/30 px-2 py-0.5 rounded">
                      {(videoBitrate / 1_000_000).toFixed(1)} Mbps
                    </span>
                  </div>
                  <input type="range" min="500000" max="8000000" step="500000" value={videoBitrate}
                    onChange={(e) => setVideoBitrate(Number(e.target.value))} className="w-full accent-rose-500" />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>0.5 Mbps</span>
                    <span>8 Mbps</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-amber-50 to-white dark:from-amber-900/20 dark:to-gray-900 border border-amber-100 dark:border-amber-900/30">
              <SectionHeader icon={Icons.audio} title="Audio" description="Audio quality settings" colorScheme={sectionColors.audio} />
              <SettingRow label="Audio Bitrate">
                <select value={audioBitrate} onChange={(e) => setAudioBitrate(Number(e.target.value))} className="input w-32 text-sm">
                  <option value="64000">64 kbps</option>
                  <option value="96000">96 kbps</option>
                  <option value="128000">128 kbps</option>
                  <option value="192000">192 kbps</option>
                  <option value="256000">256 kbps</option>
                </select>
              </SettingRow>
            </div>

            <CollapsibleSection title="Voice Activity Detection (VAD)" icon={Icons.vad} colorScheme={sectionColors.vad}>
              <div className="space-y-4">
                <SettingRow label="Enable VAD" description="Detect voice activity for active speaker switching">
                  <Toggle enabled={vadEnabled} onChange={() => setVadEnabled(!vadEnabled)} color="bg-indigo-500" />
                </SettingRow>
                {vadEnabled && (
                  <>
                    <div>
                      <label className="label mb-2">VAD Provider</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => setVadProvider('libfvad')}
                          className={`p-3 rounded-lg border-2 text-left transition-all ${
                            vadProvider === 'libfvad' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30' : 'border-gray-200 dark:border-gray-700 hover:border-indigo-300'
                          }`}>
                          <div className={`font-medium text-sm ${vadProvider === 'libfvad' ? 'text-indigo-700 dark:text-indigo-300' : ''}`}>libfvad</div>
                          <div className="text-xs text-gray-500 mt-1">WebRTC VAD, low CPU</div>
                        </button>
                        <button onClick={() => setVadProvider('silero')}
                          className={`p-3 rounded-lg border-2 text-left transition-all ${
                            vadProvider === 'silero' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30' : 'border-gray-200 dark:border-gray-700 hover:border-indigo-300'
                          }`}>
                          <div className={`font-medium text-sm ${vadProvider === 'silero' ? 'text-indigo-700 dark:text-indigo-300' : ''}`}>Silero</div>
                          <div className="text-xs text-gray-500 mt-1">Neural network, higher accuracy</div>
                        </button>
                      </div>
                    </div>
                    <SettingRow label="Show VAD Visualization" description="Display audio bars indicator (uses more CPU)">
                      <Toggle enabled={vadVisualizationEnabled} onChange={() => setVadVisualizationEnabled(!vadVisualizationEnabled)} color="bg-indigo-500" />
                    </SettingRow>
                  </>
                )}
              </div>
            </CollapsibleSection>
          </div>
        )}

        {/* Playback Tab */}
        {activeTab === 'playback' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-gradient-to-br from-cyan-50 to-white dark:from-cyan-900/20 dark:to-gray-900 border border-cyan-100 dark:border-cyan-900/30">
              <SectionHeader icon={Icons.network} title="Network" description="Transport and protocol settings" colorScheme={sectionColors.network} />
              <div className="space-y-1">
                <SettingRow label="Use Announce Flow" description="Use PUBLISH_NAMESPACE instead of PUBLISH">
                  <Toggle enabled={useAnnounceFlow} onChange={() => setUseAnnounceFlow(!useAnnounceFlow)} color="bg-cyan-500" />
                </SettingRow>
                <SettingRow label="Enable Network Stats" description="Show jitter graph under subscriptions">
                  <Toggle enabled={enableStats} onChange={() => setEnableStats(!enableStats)} color="bg-cyan-500" />
                </SettingRow>
                <SettingRow label="MOQT VarInt Encoding" description={varIntType === VarIntType.MOQT ? 'MOQT varint (Section 1.4.1)' : 'QUIC varint (RFC 9000)'}>
                  <Toggle enabled={varIntType === VarIntType.MOQT} onChange={() => setVarIntType(varIntType === VarIntType.MOQT ? VarIntType.QUIC : VarIntType.MOQT)} color="bg-cyan-500" />
                </SettingRow>
                <SettingRow label="Enable VOD Publishing" description="Publish video from URL for DVR/rewind playback">
                  <Toggle enabled={vodPublishEnabled} onChange={() => setVodPublishEnabled(!vodPublishEnabled)} color="bg-cyan-500" />
                </SettingRow>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-br from-sky-50 to-white dark:from-sky-900/20 dark:to-gray-900 border border-sky-100 dark:border-sky-900/30">
              <SectionHeader icon={Icons.profile} title="Experience Profile" description="Playback latency and buffer settings" colorScheme={sectionColors.profile} />

              <div className="mb-4 p-3 bg-white/50 dark:bg-gray-900/30 rounded-lg border border-sky-200 dark:border-sky-800/50 space-y-3">
                <SettingRow label="Buffer Policy" description="Frame release strategy for playback">
                  <select
                    value={policyType}
                    onChange={(e) => setPolicyType(e.target.value as 'vod' | 'live' | 'adaptive')}
                    className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
                  >
                    <option value="adaptive">Auto (from catalog)</option>
                    <option value="vod">VOD (Sequential)</option>
                    <option value="live">Live (Deadline-based)</option>
                  </select>
                </SettingRow>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {policyType === 'adaptive' && 'Auto mode: Uses isLive from catalog, or detects from arrival patterns'}
                  {policyType === 'vod' && 'VOD mode: Sequential playback, waits for all frames, no skipping (for DVR/recorded)'}
                  {policyType === 'live' && 'Live mode: Deadline-based with jitter buffer, can skip frames for low latency'}
                </div>
              </div>

              <div className="mb-4 flex items-center justify-center gap-1 text-[10px] text-gray-500">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Fastest</span>
                <span className="text-gray-300 dark:text-gray-600">→</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" /></span>
                <span className="text-gray-300 dark:text-gray-600">→</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" /></span>
                <span className="text-gray-300 dark:text-gray-600">→</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /></span>
                <span className="text-gray-300 dark:text-gray-600">→</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500" /> Smoothest</span>
              </div>

              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <div className="divide-y divide-gray-200 dark:divide-gray-700">
                  {EXPERIENCE_PROFILE_ORDER.map((profileName) => {
                    const profile = EXPERIENCE_PROFILES[profileName];
                    const isSelected = experienceProfile === profileName;
                    const colors = profileColors[profileName];
                    return (
                      <div key={profileName}>
                        <button onClick={() => handleProfileChange(profileName)}
                          className={`w-full px-3 py-3 flex items-center text-left transition-all border-l-4 ${
                            isSelected ? `${colors.border} ${colors.bg}` : 'border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
                          }`}>
                          <div className={`w-3 h-3 rounded-full mr-3 flex-shrink-0 ${isSelected ? colors.dot : 'bg-gray-300 dark:bg-gray-600'}`} />
                          <div className="flex-1 min-w-0">
                            <div className={`font-medium text-sm ${isSelected ? colors.text : 'text-gray-900 dark:text-gray-100'}`}>
                              {profile.displayName}
                              {isSelected && isModified && <span className="ml-1.5 text-xs font-normal text-amber-600 dark:text-amber-400">(modified)</span>}
                            </div>
                            <div className="text-xs text-gray-500 truncate">{profile.description}</div>
                          </div>
                          <div className={`ml-2 px-2.5 py-1 rounded-full text-xs font-mono font-medium ${isSelected ? colors.badge : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                            {profile.targetLatency}ms
                          </div>
                        </button>
                        {isSelected && (
                          <div className={`px-4 pb-4 border-l-4 ${colors.border} ${colors.bg}`}>
                            <div className="grid grid-cols-3 gap-2 py-3 border-b border-gray-200/50 dark:border-gray-700/50 mb-3">
                              <div className="text-center p-2.5 bg-white/60 dark:bg-gray-900/40 rounded-lg">
                                <div className="font-mono text-base font-bold text-gray-900 dark:text-white">{jitterBufferDelay}<span className="text-xs font-normal text-gray-400">ms</span></div>
                                <div className="text-gray-500 text-[10px] font-medium uppercase tracking-wide">Buffer</div>
                              </div>
                              <div className="text-center p-2.5 bg-white/60 dark:bg-gray-900/40 rounded-lg">
                                <div className="font-mono text-base font-bold text-gray-900 dark:text-white">{maxLatency}<span className="text-xs font-normal text-gray-400">ms</span></div>
                                <div className="text-gray-500 text-[10px] font-medium uppercase tracking-wide">Max Latency</div>
                              </div>
                              <div className="text-center p-2.5 bg-white/60 dark:bg-gray-900/40 rounded-lg">
                                <div className={`text-base font-bold ${useLatencyDeadline ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
                                  {useLatencyDeadline ? 'ON' : 'OFF'}
                                </div>
                                <div className="text-gray-500 text-[10px] font-medium uppercase tracking-wide">Interactive</div>
                              </div>
                            </div>
                            <button onClick={() => setShowFineTune(!showFineTune)}
                              className={`flex items-center text-xs font-medium transition-colors ${showFineTune ? 'text-gray-600 dark:text-gray-400' : `${colors.text} hover:opacity-80`}`}>
                              <span className={`mr-1.5 transition-transform ${showFineTune ? 'rotate-90' : ''}`}>{Icons.chevronRight}</span>
                              {showFineTune ? 'Hide settings' : 'Fine-tune settings'}
                            </button>
                            {showFineTune && <div className="mt-4">{renderFineTuneControls()}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div>
                    <button onClick={() => handleProfileChange('custom')}
                      className={`w-full px-3 py-3 flex items-center text-left transition-all border-l-4 ${
                        experienceProfile === 'custom' ? `${profileColors.custom.border} ${profileColors.custom.bg}` : 'border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
                      }`}>
                      <div className={`w-3 h-3 rounded-full mr-3 flex-shrink-0 ${experienceProfile === 'custom' ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                      <div className="flex-1">
                        <div className={`font-medium text-sm ${experienceProfile === 'custom' ? profileColors.custom.text : 'text-gray-900 dark:text-gray-100'}`}>Custom</div>
                        <div className="text-xs text-gray-500">Manually configured settings</div>
                      </div>
                    </button>
                    {experienceProfile === 'custom' && (
                      <div className={`px-4 pb-4 border-l-4 ${profileColors.custom.border} ${profileColors.custom.bg}`}>
                        <div className="py-3 text-xs text-purple-600 dark:text-purple-400 border-b border-purple-200 dark:border-purple-800/30 mb-4">
                          Settings have been customized and don't match any preset profile.
                        </div>
                        {renderFineTuneControls()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Security Tab */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-900/20 dark:to-gray-900 border border-emerald-100 dark:border-emerald-900/30">
              <SectionHeader icon={Icons.lock} title="End-to-End Encryption" description="Secure Objects (E2EE) for media streams" colorScheme={sectionColors.security} />

              <div className="space-y-4">
                <SettingRow label="Enable Encryption" description="Encrypt media with MOQT Secure Objects">
                  <Toggle enabled={secureObjectsEnabled} onChange={() => setSecureObjectsEnabled(!secureObjectsEnabled)} color="bg-emerald-500" />
                </SettingRow>

                {secureObjectsEnabled && (
                  <div className="pt-2 space-y-4">
                    <div>
                      <label className="label">Cipher Suite</label>
                      <select value={secureObjectsCipherSuite} onChange={(e) => setSecureObjectsCipherSuite(e.target.value)} className="input text-sm">
                        <option value="0x0004">AES-128-GCM (recommended)</option>
                        <option value="0x0005">AES-256-GCM</option>
                        <option value="0x0001">AES-128-CTR-HMAC-80</option>
                        <option value="0x0002">AES-128-CTR-HMAC-64</option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1">AES-GCM is recommended for best WebCrypto performance</p>
                    </div>

                    <div>
                      <label className="label flex items-center">
                        Track Base Key
                        <InfoTip text="Shared secret for encryption. Must be 32-64 hex characters (16-32 bytes). Both publisher and subscriber need the same key." align="right" />
                      </label>
                      <div className="relative">
                        <input
                          type={showBaseKey ? 'text' : 'password'}
                          value={secureObjectsBaseKey}
                          onChange={(e) => setSecureObjectsBaseKey(e.target.value)}
                          placeholder="Enter hex key (e.g., 0123456789abcdef...)"
                          className="input font-mono text-sm pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowBaseKey(!showBaseKey)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                          title={showBaseKey ? 'Hide key' : 'Show key'}
                        >
                          {showBaseKey ? Icons.eyeClosed : Icons.eyeOpen}
                        </button>
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        <p className="text-xs text-gray-500">
                          {secureObjectsBaseKey.length > 0
                            ? `${secureObjectsBaseKey.length} hex chars (${Math.floor(secureObjectsBaseKey.length / 2)} bytes)`
                            : 'Required for encryption'}
                        </p>
                        <button
                          onClick={() => {
                            const bytes = new Uint8Array(32);
                            crypto.getRandomValues(bytes);
                            const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                            setSecureObjectsBaseKey(hex);
                          }}
                          className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                        >
                          Generate Random Key
                        </button>
                      </div>
                      {secureObjectsBaseKey.length > 0 && secureObjectsBaseKey.length < 32 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          Key too short. Minimum 32 hex characters (16 bytes) required.
                        </p>
                      )}
                      {secureObjectsBaseKey.length > 0 && !/^[0-9a-fA-F]*$/.test(secureObjectsBaseKey) && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                          Invalid characters. Only hex digits (0-9, a-f) allowed.
                        </p>
                      )}
                    </div>

                    {/* Status indicator */}
                    {secureObjectsBaseKey.length >= 32 && /^[0-9a-fA-F]*$/.test(secureObjectsBaseKey) && (
                      <div className="p-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg border border-emerald-200 dark:border-emerald-800">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                            Encryption Ready
                          </span>
                        </div>
                        <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
                          Media will be encrypted using {secureObjectsCipherSuite === '0x0004' ? 'AES-128-GCM' : secureObjectsCipherSuite === '0x0005' ? 'AES-256-GCM' : 'AES-CTR-HMAC'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!secureObjectsEnabled && (
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/30 border border-gray-200 dark:border-gray-700/50">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800">
                    <span className="text-gray-400">{Icons.key}</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">About Secure Objects</h4>
                    <p className="text-xs text-gray-500 mt-1">
                      MOQT Secure Objects provides end-to-end encryption for media streams.
                      When enabled, media is encrypted before transmission and can only be
                      decrypted by participants with the shared key.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
