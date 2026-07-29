import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { useRecorder } from '../hooks/useRecorder';
import { DEFAULTS } from '../lib/constants';

export function JoinScreen() {
  const roomId = useStore((s) => s.roomId);
  const setRoomId = useStore((s) => s.setRoomId);
  const displayName = useStore((s) => s.displayName);
  const setDisplayName = useStore((s) => s.setDisplayName);
  const relayUrl = useStore((s) => s.relayUrl);
  const setRelayUrl = useStore((s) => s.setRelayUrl);
  const topNVideo = useStore((s) => s.topNVideo);
  const setTopNVideo = useStore((s) => s.setTopNVideo);
  const setJoined = useStore((s) => s.setJoined);
  const isBot = useStore((s) => s.isBot);
  const setIsBot = useStore((s) => s.setIsBot);
  const [showSettings, setShowSettings] = useState(false);
  const { recording, startRecording, stopRecording } = useRecorder();

  useEffect(() => {
    if (isBot) {
      const id = `bot-${Math.random().toString(36).slice(2, 6)}`;
      setDisplayName(id);
    }
  }, [isBot, setDisplayName]);

  const handleJoin = () => {
    if (roomId.trim() && displayName.trim()) {
      setJoined(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleJoin();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900 p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600/20">
            <svg className="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">MOCHA Meet</h1>
          <p className="mt-1 text-sm text-gray-400">
            Low-latency conferencing with active speaker detection using MoQ Relays
          </p>
        </div>

        {/* Join Form */}
        <div className="rounded-2xl bg-gray-800/50 p-6 shadow-xl ring-1 ring-white/5">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">Room ID</label>
              <input
                type="text"
                placeholder="e.g. standup-daily"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full rounded-lg border border-gray-700 bg-gray-900/50 px-4 py-2.5 text-white placeholder-gray-500 transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">Display Name</label>
              <input
                type="text"
                placeholder="Your name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isBot}
                className={`w-full rounded-lg border border-gray-700 bg-gray-900/50 px-4 py-2.5 text-white placeholder-gray-500 transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${isBot ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </div>

            {/* Bot toggle */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setIsBot(!isBot)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isBot ? 'bg-indigo-600' : 'bg-gray-600'}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isBot ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
              <span className="text-sm text-gray-300">Join as Bot</span>
              {isBot && (
                <span className="rounded bg-indigo-900/50 px-2 py-0.5 text-xs text-indigo-300">
                  Synthetic participant
                </span>
              )}
            </div>

            <button
              onClick={handleJoin}
              disabled={!roomId.trim() || !displayName.trim()}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Join Meeting
            </button>
          </div>

          {/* Record */}
          <div className="mt-4 border-t border-gray-700/50 pt-4">
            <button
              onClick={recording ? stopRecording : startRecording}
              className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                recording
                  ? 'bg-red-600 text-white animate-pulse hover:bg-red-700'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              <svg className="h-4 w-4" fill={recording ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="12" r="8" strokeWidth={2} />
              </svg>
              {recording ? 'Stop Recording' : 'Record Screen'}
            </button>
          </div>

          {/* Settings toggle */}
          <div className="mt-4 border-t border-gray-700/50 pt-4">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex w-full items-center justify-between text-sm text-gray-400 hover:text-gray-300"
            >
              <span>Advanced Settings</span>
              <svg
                className={`h-4 w-4 transition-transform ${showSettings ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showSettings && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-400">Relay</label>
                  <select
                    value={relayUrl}
                    onChange={(e) => setRelayUrl(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
                  >
                    <option value="auto">Auto (nearest)</option>
                    <option value="https://relay.mocha-net.dev">US West</option>
                    <option value="https://relay-eu.mocha-net.dev">EU Frankfurt</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-400">
                    Active Speakers (Top-N Video)
                  </label>
                  <div className="flex gap-2">
                    {[1, 2].map((n) => (
                      <button
                        key={n}
                        onClick={() => setTopNVideo(n)}
                        className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
                          topNVideo === n
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        Top-{n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
