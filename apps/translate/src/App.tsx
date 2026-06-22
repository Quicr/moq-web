import { useState, useRef, useCallback } from 'react';
import { EzDubsWebClient, type RemoteParticipant, type SessionConfig, type TranscriptEntry } from './moq-client';
import { AudioCapturePipeline, AudioPlaybackPipeline } from './audio-pipeline';
import { negotiateMOQSession, type MOQSessionInfo } from './ws-negotiate';

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

function App() {
  // Join config
  const [meetingId, setMeetingId] = useState('test-web-1');
  const [myLanguage, setMyLanguage] = useState('en');
  const [mode, setMode] = useState<'interactive' | 'speaker' | 'listener'>('interactive');
  const [serverHost, setServerHost] = useState('moq-ws.s2s.ezdubs.amer.cint.vcra.co');
  const [serverPort, setServerPort] = useState('443');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // State
  const [connected, setConnected] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState('Ready to join');
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [audioStats, setAudioStats] = useState({ sent: 0, received: 0 });
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [moqInfo, setMoqInfo] = useState<MOQSessionInfo | null>(null);

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

  const handleJoin = async () => {
    if (!meetingId.trim()) {
      setStatus('Meeting ID required');
      return;
    }

    try {
      // Step 1: WS negotiation to get relay URL
      setStatus('Negotiating session...');
      const info = await negotiateMOQSession({
        host: serverHost,
        port: serverPort,
        meetingId: meetingId.trim(),
        participantLang: myLanguage,
        sampleRate: 48000,
      });
      setMoqInfo(info);
      setStatus(`Got relay: ${info.relayUrl}`);

      // Step 2: Connect to MOQ relay
      const wtUrl = info.relayUrl
        .replace('moq://', 'https://')
        .replace('relay.us-west-2.m10x.org', 'conf.quicr.ctgpoc.com');
      const config: SessionConfig = {
        relayUrl: wtUrl.endsWith('/relay') ? wtUrl : wtUrl + '/relay',
        namespacePrefix: info.namespacePrefix,
        sessionId: info.sessionId,
        participantId: `web-${myLanguage}-${Date.now().toString(36)}`,
        sourceLanguage: myLanguage,
        targetLanguage: myLanguage,
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
          const filtered = prev.filter(
            e => !(e.participantId === t.participantId && !e.isFinal)
          );
          return [...filtered, t].slice(-50);
        });
      });

      // Set up playback (listener and interactive modes)
      if (mode !== 'speaker') {
        const playback = new AudioPlaybackPipeline(48000);
        await playback.start(48000, 1);
        playbackRef.current = playback;

        client.setOnAudioReceived((_participantId, data, _groupId, _objectId) => {
          timestampRef.current += 20_000;
          playback.decode(data, timestampRef.current);
          updateStats('received');
        });
      }

      await client.connect();

      // Subscribe only for listener and interactive modes
      if (mode !== 'speaker') {
        await client.subscribePassthrough();
        await client.subscribeServerOutput();
      }

      clientRef.current = client;
      setConnected(true);

      // Auto-start mic for speaker and interactive modes
      if (mode !== 'listener') {
        setStatus('Connected - starting mic...');
        try {
          if (playbackRef.current) await playbackRef.current.resume();
          await client.startPublishing();

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
          setStatus(mode === 'speaker' ? 'Publishing audio' : 'Connected - speaking');
        } catch (err) {
          setStatus(`Mic error: ${(err as Error).message}`);
        }
      } else {
        setStatus('Listening...');
      }
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`);
    }
  };

  const handleLeave = async () => {
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
    setMoqInfo(null);
    statsRef.current = { sent: 0, received: 0 };
    setAudioStats({ sent: 0, received: 0 });
    timestampRef.current = 0;
    setStatus('Ready to join');
  };

  const handleToggleMic = async () => {
    if (!clientRef.current) return;

    if (publishing) {
      if (captureRef.current) {
        await captureRef.current.stop();
        captureRef.current = null;
      }
      setPublishing(false);
      setStatus('Mic off');
    } else {
      try {
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
        setStatus('Speaking...');
      } catch (err) {
        setStatus(`Mic error: ${(err as Error).message}`);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-center">EzDubs Translate</h1>

        {!connected ? (
          /* Join Screen */
          <div className="bg-gray-800 rounded-lg p-5 space-y-4">
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Meeting ID</label>
                <input
                  type="text"
                  value={meetingId}
                  onChange={e => setMeetingId(e.target.value)}
                  placeholder="Enter meeting ID"
                  className="w-full bg-gray-700 rounded px-3 py-2 text-lg"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">I speak</label>
                <select
                  value={myLanguage}
                  onChange={e => setMyLanguage(e.target.value)}
                  className="w-full bg-gray-700 rounded px-3 py-2 text-lg"
                >
                  {LANGUAGES.map(l => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Mode</label>
                <div className="flex gap-2">
                  {(['interactive', 'speaker', 'listener'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`flex-1 px-3 py-2 rounded text-sm capitalize ${
                        mode === m
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Advanced settings (collapsed by default) */}
            <div>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced settings
              </button>
              {showAdvanced && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Server Host</label>
                    <input
                      type="text"
                      value={serverHost}
                      onChange={e => setServerHost(e.target.value)}
                      className="w-full bg-gray-700 rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Server Port</label>
                    <input
                      type="text"
                      value={serverPort}
                      onChange={e => setServerPort(e.target.value)}
                      className="w-full bg-gray-700 rounded px-2 py-1 text-sm"
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={handleJoin}
              className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-lg"
            >
              Join Meeting
            </button>
          </div>
        ) : (
          /* In-meeting Screen */
          <>
            {/* Meeting header */}
            <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
              <div>
                <span className="text-sm text-gray-400">Meeting: </span>
                <span className="font-medium">{meetingId}</span>
                <span className="text-sm text-gray-400 ml-3">Lang: </span>
                <span className="font-medium">{LANGUAGES.find(l => l.code === myLanguage)?.label}</span>
              </div>
              <button
                onClick={handleLeave}
                className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm"
              >
                Leave
              </button>
            </div>

            {/* Mic button (not shown for listener mode) */}
            {mode !== 'listener' && (
              <div className="flex justify-center">
                <button
                  onClick={handleToggleMic}
                  className={`w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold transition-colors ${
                    publishing
                      ? 'bg-red-500 hover:bg-red-600 animate-pulse'
                      : 'bg-green-600 hover:bg-green-700'
                  }`}
                >
                  {publishing ? 'ON' : 'MIC'}
                </button>
              </div>
            )}

            {/* Stats */}
            <div className="text-center text-xs text-gray-500">
              Sent: {audioStats.sent} | Received: {audioStats.received}
              {participants.length > 0 && ` | Participants: ${participants.length}`}
            </div>

            {/* Transcripts */}
            {transcripts.length > 0 && (
              <div className="bg-gray-800 rounded-lg p-4 space-y-1">
                <h2 className="text-sm font-semibold text-gray-400 mb-2">Transcripts</h2>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {transcripts.map((t, i) => (
                    <div key={i} className={`text-sm ${t.isFinal ? 'text-gray-200' : 'text-gray-400 italic'}`}>
                      <span className={`font-medium ${t.isTranslation ? 'text-blue-400' : 'text-green-400'}`}>
                        [{t.language}{t.isTranslation ? ' translated' : ''}]
                      </span>
                      <span className="ml-2">{t.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Participants */}
            {participants.length > 0 && (
              <div className="bg-gray-800 rounded-lg p-4">
                <h2 className="text-sm font-semibold text-gray-400 mb-2">Participants</h2>
                <div className="space-y-1">
                  {participants.map(p => (
                    <div key={p.id} className="text-sm flex items-center gap-2">
                      <span className="w-2 h-2 bg-green-400 rounded-full" />
                      {p.id}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Status bar */}
        <div className="text-center text-xs text-gray-500 font-mono">{status}</div>

        {/* Debug: MOQ info */}
        {moqInfo && showAdvanced && (
          <div className="text-xs text-gray-600 font-mono">
            Relay: {moqInfo.relayUrl} | NS: {moqInfo.namespacePrefix.join('/')} | Session: {moqInfo.sessionId}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
