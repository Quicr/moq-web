// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Main Application Component
 *
 * Root component for the MOQT client application.
 * Provides the main layout with connection, publish, subscribe,
 * and chat panels.
 */

import React from 'react';
import { useStore } from './store';
import { ConnectionPanel } from './components/connection/ConnectionPanel';
import { ConnectionStatus } from './components/connection/ConnectionStatus';
import { PublishPanel } from './components/publish/PublishPanel';
import { SubscribePanel } from './components/subscribe/SubscribePanel';
import { ChatPanel } from './components/chat/ChatPanel';
import { SettingsPanel } from './components/common/SettingsPanel';
import { StatusPanel } from './components/common/StatusPanel';
import { DevSettingsPanel } from './components/common/DevSettingsPanel';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = React.useState<'publish' | 'subscribe' | 'chat'>('publish');
  const [showSettings, setShowSettings] = React.useState(false);
  const { state } = useStore();

  const isConnected = state === 'connected';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold text-primary-600 dark:text-primary-400">
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
            <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
              <button
                onClick={() => setActiveTab('publish')}
                className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                  activeTab === 'publish'
                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Publish
              </button>
              <button
                onClick={() => setActiveTab('subscribe')}
                className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                  activeTab === 'subscribe'
                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Subscribe
              </button>
              <button
                onClick={() => setActiveTab('chat')}
                className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                  activeTab === 'chat'
                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Chat
              </button>
            </div>

            {/* Tab Content */}
            <div className="min-h-[500px]">
              {!isConnected && (
                <div className="panel p-8 text-center">
                  <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                  </svg>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                    Not Connected
                  </h3>
                  <p className="text-gray-500 dark:text-gray-400">
                    Connect to a MOQT relay to start publishing or subscribing to media.
                  </p>
                </div>
              )}

              {/* Keep panels mounted to preserve state, hide inactive ones */}
              <div className={activeTab === 'publish' ? '' : 'hidden'}>{isConnected && <PublishPanel />}</div>
              <div className={activeTab === 'subscribe' ? '' : 'hidden'}>{isConnected && <SubscribePanel />}</div>
              <div className={activeTab === 'chat' ? '' : 'hidden'}>{isConnected && <ChatPanel />}</div>
            </div>
          </div>
        </div>
      </main>

      {/* Developer Settings Panel (only shows with ?debug=1) */}
      <DevSettingsPanel />

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div
              className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
              onClick={() => setShowSettings(false)}
            />
            <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
                <h2 className="text-lg font-semibold">Settings</h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="btn-icon btn-secondary"
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
