import { useState, useRef, useCallback } from 'react';
import { EzDubsWebClient, type RemoteParticipant, type SessionConfig, type TranscriptEntry } from './moq-client';
import { AudioCapturePipeline, AudioPlaybackPipeline } from './audio-pipeline';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ar', label: 'Arabic' },
];

const DEFAULT_RELAY = 'https://relay.us-west-2.m10x.org:33435/moq';
const DEFAULT_PREFIX = 'ezdubs,test1';

function App() {
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [namespacePrefix, setNamespacePrefix] = useState(DEFAULT_PREFIX);
  const [sessionId, setSessionId] = useState(() => `web-${Date.now()}`);
  const [participantId, setParticipantId] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('es');

  const [connected, setConnected] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [audioStats, setAudioStats] = useState({ sent: 0, received: 0 });
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);

  const clientRef = useRef<EzDubsWebClient | null>(null);
  const captureRef = useRef<AudioCapturePipeline | null>(null);
  const playbackRef = useRef<AudioPlaybackPipeline | null>(null);
  const statsRef = useRef({ sent: 0, received: 0 });
  const timestampRef = useRef(0);

  const updateStats = useCallback((key: 'sent' | 'received') => {
    statsRef.current[key]++;
    if (statsRef.current[key] % 25 === 0) {
      setAudioStats({ ...statsRef.current });
    }
  }, []);

  const handleConnect = async () => {
    if (!participantId.trim()) {
      setStatus('Error: Participant ID required');
      return;
    }

    try {
      const config: SessionConfig = {
        relayUrl,
        namespacePrefix: namespacePrefix.split(',').map(s => s.trim()),
        sessionId,
        participantId: participantId.trim(),
        sourceLanguage,
        targetLanguage,
      };

      const client = new EzDubsWebClient(config);
      client.setOnStatusChange(setStatus);
      client.setOnParticipantDiscovered((p) => {
        setParticipants(prev => {
          if (prev.find(x => x.id === p.id)) return prev;
          return [...prev, p];
        });
      });
      client.setOnTranscriptReceived((t) => {
        setTranscripts(prev => {
          if (t.isFinal) {
            // Replace the last interim entry from same participant
            const filtered = prev.filter(
              e => !(e.participantId === t.participantId && !e.isFinal)
            );
            return [...filtered, t].slice(-50);
          }
          // Interim: replace any existing interim from same participant
          const filtered = prev.filter(
            e => !(e.participantId === t.participantId && !e.isFinal)
          );
          return [...filtered, t].slice(-50);
        });
      });

      // Set up playback pipeline
      const playback = new AudioPlaybackPipeline(48000);
      await playback.start(48000, 1);
      playbackRef.current = playback;

      client.setOnAudioReceived((_participantId, data, _groupId, _objectId) => {
        timestampRef.current += 20_000;
        playback.decode(data, timestampRef.current);
        updateStats('received');
      });

      await client.connect();

      // Subscribe to passthrough and server output
      await client.subscribePassthrough();
      await client.subscribeServerOutput();

      clientRef.current = client;
      setConnected(true);
      setStatus('Connected - subscribing to namespaces');
    } catch (err) {
      setStatus(`Connection failed: ${(err as Error).message}`);
    }
  };

  const handleDisconnect = async () => {
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    if (playbackRef.current) {
      await playbackRef.current.stop();
      playbackRef.current = null;
    }
    if (clientRef.current) {
      await clientRef.current.disconnect();
      clientRef.current = null;
    }
    setConnected(false);
    setPublishing(false);
    setParticipants([]);
    setTranscripts([]);
    statsRef.current = { sent: 0, received: 0 };
    setAudioStats({ sent: 0, received: 0 });
    timestampRef.current = 0;
  };

  const handleStartPublish = async () => {
    if (!clientRef.current) return;

    try {
      // Resume audio context (required after user gesture)
      await playbackRef.current?.resume();

      await clientRef.current.startPublishing();

      const capture = new AudioCapturePipeline({
        sampleRate: 48000,
        channels: 1,
        bitrate: 32000,
        onEncodedFrame: (frame) => {
          clientRef.current?.sendAudioObject(frame);
          updateStats('sent');
        },
      });

      await capture.start();
      captureRef.current = capture;
      setPublishing(true);
      setStatus('Publishing audio');
    } catch (err) {
      setStatus(`Publish failed: ${(err as Error).message}`);
    }
  };

  const handleStopPublish = async () => {
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    setPublishing(false);
    setStatus('Stopped publishing');
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">EzDubs Translate</h1>

        {/* Connection Settings */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-3">
          <h2 className="text-lg font-semibold">Connection</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Relay URL</label>
              <input
                type="text"
                value={relayUrl}
                onChange={e => setRelayUrl(e.target.value)}
                disabled={connected}
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Namespace Prefix</label>
              <input
                type="text"
                value={namespacePrefix}
                onChange={e => setNamespacePrefix(e.target.value)}
                disabled={connected}
                placeholder="ezdubs,test1"
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Session ID</label>
              <input
                type="text"
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
                disabled={connected}
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Participant ID</label>
              <input
                type="text"
                value={participantId}
                onChange={e => setParticipantId(e.target.value)}
                disabled={connected}
                placeholder="alice"
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">I speak</label>
              <select
                value={sourceLanguage}
                onChange={e => setSourceLanguage(e.target.value)}
                disabled={connected}
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">I want to hear</label>
              <select
                value={targetLanguage}
                onChange={e => setTargetLanguage(e.target.value)}
                disabled={connected}
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            {!connected ? (
              <button
                onClick={handleConnect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium"
              >
                Connect
              </button>
            ) : (
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Audio Controls */}
        {connected && (
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <h2 className="text-lg font-semibold">Audio</h2>
            <div className="flex gap-3">
              {!publishing ? (
                <button
                  onClick={handleStartPublish}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded font-medium"
                >
                  Start Microphone
                </button>
              ) : (
                <button
                  onClick={handleStopPublish}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 rounded font-medium"
                >
                  Stop Microphone
                </button>
              )}
            </div>
            <div className="text-sm text-gray-400 flex gap-6">
              <span>Sent: {audioStats.sent} frames</span>
              <span>Received: {audioStats.received} frames</span>
            </div>
          </div>
        )}

        {/* Participants */}
        {connected && (
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <h2 className="text-lg font-semibold">Participants</h2>
            {participants.length === 0 ? (
              <p className="text-sm text-gray-400">No participants discovered yet</p>
            ) : (
              <ul className="space-y-1">
                {participants.map(p => (
                  <li key={p.id} className="text-sm flex items-center gap-2">
                    <span className="w-2 h-2 bg-green-400 rounded-full" />
                    {p.id}
                    <span className="text-gray-500 text-xs">({p.namespace.join('/')})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Transcripts */}
        {connected && transcripts.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-4 space-y-2">
            <h2 className="text-lg font-semibold">Transcripts</h2>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {transcripts.map((t, i) => (
                <div key={i} className={`text-sm ${t.isFinal ? 'text-gray-200' : 'text-gray-400 italic'}`}>
                  <span className="font-medium text-blue-400">{t.participantId}</span>
                  <span className="text-gray-500 text-xs ml-1">
                    [{t.language}{t.isTranslation ? ' translated' : ''}]
                  </span>
                  <span className="ml-2">{t.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-2">Status</h2>
          <p className="text-sm text-gray-300 font-mono">{status}</p>
        </div>
      </div>
    </div>
  );
}

export default App;
