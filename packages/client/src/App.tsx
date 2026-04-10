// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Main Application Component
 *
 * Root component for the MOQT client application.
 * Glassmorphic design with offline configuration support.
 */

import React from 'react';
import { useStore } from './store';
import { ConnectionPanel } from './components/connection/ConnectionPanel';
import { ConnectionStatus } from './components/connection/ConnectionStatus';
import { PublishPanel } from './components/publish/PublishPanel';
import { SubscribePanel } from './components/subscribe/SubscribePanel';
import { ChatPanel } from './components/chat/ChatPanel';
import { CatalogPanel } from './components/catalog/CatalogPanel';
import { SettingsPanel } from './components/common/SettingsPanel';
import { StatusPanel } from './components/common/StatusPanel';
import { DevSettingsPanel } from './components/common/DevSettingsPanel';
import { DecodeErrorToast } from './components/common/DecodeErrorToast';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = React.useState<'publish' | 'subscribe' | 'chat' | 'catalog'>('catalog');
  const [showSettings, setShowSettings] = React.useState(false);
  const { state } = useStore();

  const isConnected = state === 'connected';

  const tabs = [
    { id: 'publish' as const, label: 'Publish', icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    )},
    { id: 'subscribe' as const, label: 'Subscribe', icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    )},
    { id: 'chat' as const, label: 'Chat', icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    )},
    { id: 'catalog' as const, label: 'Catalog', icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    )},
  ];

  return (
    <div className="min-h-screen text-gray-100">
      {/* Mesh Gradient Background */}
      <div className="app-background" />

      {/* Header */}
      <header className="sticky top-0 z-20">
        <div className="glass-panel rounded-none border-x-0 border-t-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center gap-4">
                <h1 className="text-xl font-bold text-gradient">
                  MOQT Client
                </h1>
                <ConnectionStatus />
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="btn-icon btn-secondary"
                  title="Settings"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left Sidebar - Connection */}
          <div className="lg:col-span-1 space-y-4">
            <ConnectionPanel />
            <StatusPanel />
          </div>

          {/* Main Area */}
          <div className="lg:col-span-3">
            {/* Tabs */}
            <div className="tab-list mb-6">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`tab flex items-center gap-2 ${activeTab === tab.id ? 'tab-active' : ''}`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Tab Content - Always rendered, panels handle their own connection state */}
            <div className="min-h-[500px]">
              {/* Connection hint banner when not connected */}
              {!isConnected && (
                <div className="glass-panel-subtle p-4 mb-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-accent-purple/20 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white/90 text-sm font-medium">Configure First, Connect When Ready</p>
                    <p className="text-white/50 text-xs">
                      Set up your tracks and settings offline. Click "Connect & Go" when you're ready to publish or subscribe.
                    </p>
                  </div>
                </div>
              )}

              {/* Panels - always mounted to preserve state */}
              <div className={activeTab === 'publish' ? '' : 'hidden'}>
                <PublishPanel />
              </div>
              <div className={activeTab === 'subscribe' ? '' : 'hidden'}>
                <SubscribePanel />
              </div>
              <div className={activeTab === 'chat' ? '' : 'hidden'}>
                <ChatPanel />
              </div>
              <div className={activeTab === 'catalog' ? '' : 'hidden'}>
                <CatalogPanel />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Developer Settings Panel (only shows with ?debug=1) */}
      <DevSettingsPanel />

      {/* Decode Error Toasts */}
      <DecodeErrorToast />

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setShowSettings(false)}
            />
            <div className="relative z-10 glass-panel-glow max-w-md w-full">
              <div className="flex items-center justify-between p-5 border-b border-white/10">
                <h2 className="text-lg font-semibold text-white">Settings</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="btn-icon btn-ghost"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <SettingsPanel />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
