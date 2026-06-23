import { useState, useRef, useCallback, useEffect } from 'react';
import { EzDubsWebClient, type RemoteParticipant, type SessionConfig, type TranscriptEntry } from './moq-client';
import { AudioCapturePipeline, AudioPlaybackPipeline } from './audio-pipeline';
import { negotiateMOQSession, type MOQSessionInfo } from './ws-negotiate';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'no', label: 'Norwegian' },
];

interface ParticipantTranscripts {
  [participantId: string]: TranscriptEntry[];
}

function App() {
  const [meetingId, setMeetingId] = useState('test-web-1');
  const [myLanguage, setMyLanguage] = useState('en');
  const [mode, setMode] = useState<'interactive' | 'speaker' | 'listener'>('interactive');
  const [serverHost, setServerHost] = useState('moq-ws.s2s.ezdubs.amer.cint.vcra.co');
  const [serverPort, setServerPort] = useState('443');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [connected, setConnected] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState('idle');
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [audioStats, setAudioStats] = useState({ sent: 0, received: 0 });
  const [transcriptsByParticipant, setTranscriptsByParticipant] = useState<ParticipantTranscripts>({});
  const [moqInfo, setMoqInfo] = useState<MOQSessionInfo | null>(null);
  const [myParticipantId, setMyParticipantId] = useState('');

  const clientRef = useRef<EzDubsWebClient | null>(null);
  const captureRef = useRef<AudioCapturePipeline | null>(null);
  const playbackRef = useRef<AudioPlaybackPipeline | null>(null);
  const statsRef = useRef({ sent: 0, received: 0 });
  const timestampRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const updateStats = useCallback((key: 'sent' | 'received') => {
    statsRef.current[key]++;
    if (statsRef.current[key] % 25 === 0) {
      setAudioStats({ ...statsRef.current });
    }
  }, []);

  const handleTranscript = useCallback((t: TranscriptEntry) => {
    setTranscriptsByParticipant(prev => {
      const pid = t.participantId || 'unknown';
      const existing = prev[pid] || [];
      const filtered = existing.filter(e => e.isFinal || e.participantId !== t.participantId);
      if (!t.isFinal) {
        return { ...prev, [pid]: [...filtered, t] };
      }
      return { ...prev, [pid]: [...filtered, t].slice(-20) };
    });
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptsByParticipant]);

  const handleJoin = async () => {
    if (!meetingId.trim()) {
      setStatus('err: session_id required');
      return;
    }

    try {
      setStatus('negotiating...');
      const info = await negotiateMOQSession({
        host: serverHost,
        port: serverPort,
        meetingId: meetingId.trim(),
        participantLang: myLanguage,
        sampleRate: 48000,
      });
      setMoqInfo(info);
      setStatus(`relay: ${info.relayUrl.split('//')[1]}`);

      const wtUrl = info.relayUrl
        .replace('moq://', 'https://')
        .replace('relay.us-west-2.m10x.org', 'conf.quicr.ctgpoc.com');
      const participantId = `web-${myLanguage}-${Date.now().toString(36)}`;
      setMyParticipantId(participantId);

      const config: SessionConfig = {
        relayUrl: wtUrl.endsWith('/relay') ? wtUrl : wtUrl + '/relay',
        namespacePrefix: info.namespacePrefix,
        sessionId: info.sessionId,
        participantId,
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
      client.setOnTranscriptReceived(handleTranscript);

      if (mode !== 'speaker') {
        const playback = new AudioPlaybackPipeline(48000);
        await playback.start(48000, 1);
        await playback.resume();
        playbackRef.current = playback;

        client.setOnAudioReceived((_participantId, data, _groupId, _objectId) => {
          timestampRef.current += 20_000;
          playback.decode(data, timestampRef.current);
          updateStats('received');
        });
      }

      await client.connect();
      await client.subscribeServerOutput();

      clientRef.current = client;
      setConnected(true);

      if (mode !== 'listener') {
        setStatus('opening mic...');
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
          setStatus('streaming');
        } catch (err) {
          setStatus(`mic_err: ${(err as Error).message}`);
        }
      } else {
        setStatus('listening');
      }
    } catch (err) {
      setStatus(`fail: ${(err as Error).message}`);
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
    setTranscriptsByParticipant({});
    setMoqInfo(null);
    setMyParticipantId('');
    statsRef.current = { sent: 0, received: 0 };
    setAudioStats({ sent: 0, received: 0 });
    timestampRef.current = 0;
    setStatus('idle');
  };

  const handleToggleMic = async () => {
    if (!clientRef.current) return;

    if (publishing) {
      if (captureRef.current) {
        await captureRef.current.stop();
        captureRef.current = null;
      }
      setPublishing(false);
      setStatus('mic_off');
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
        setStatus('streaming');
      } catch (err) {
        setStatus(`mic_err: ${(err as Error).message}`);
      }
    }
  };

  const participantIds = Object.keys(transcriptsByParticipant);

  return (
    <div className="scene p-6">
      <div className="max-w-3xl mx-auto space-y-6 relative z-10">

        {/* Title */}
        <div className="text-center pt-6 pb-2">
          <div className="flex justify-center mb-3">
            <svg width="80" height="60" viewBox="0 0 80 60" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-90">
              <rect x="20" y="25" width="40" height="30" rx="2" stroke="url(#boxGrad)" strokeWidth="1.5" fill="rgba(124,58,237,0.05)" />
              <path d="M20 25 L40 18 L60 25" stroke="url(#boxGrad)" strokeWidth="1.5" fill="rgba(168,85,247,0.08)" />
              <path d="M40 18 L40 25" stroke="url(#boxGrad)" strokeWidth="1" strokeDasharray="2 2" />
              <path d="M12 32 C12 28 14 26 15 24 C14 22 15 20 16 19 C17 17 15 15 17 14 C19 13 18 15 19 14 C20 12 19 13 20 14 C21 12 22 14 21 15 C23 15 22 17 21 18 C22 19 23 21 22 23 C23 25 21 27 20 28 C19 30 18 31 17 33" stroke="#a78bfa" strokeWidth="1.2" fill="rgba(167,139,250,0.1)" strokeLinecap="round" />
              <path d="M62 30 C63 27 65 25 66 23 C67 21 66 19 67 18 C68 16 70 17 70 15 C70 13 72 14 71 16 C73 15 73 17 72 18 C73 19 74 21 73 23 C74 25 72 27 71 29 C70 31 69 32 68 33" stroke="#f59e0b" strokeWidth="1.2" fill="rgba(245,158,11,0.1)" strokeLinecap="round" />
              <path d="M67 21 L69 22" stroke="#f59e0b" strokeWidth="0.8" opacity="0.6" />
              <path d="M66 24 L68 25" stroke="#f59e0b" strokeWidth="0.8" opacity="0.6" />
              <path d="M6 35 Q10 33 14 35" stroke="#06d6a0" strokeWidth="1" fill="none" opacity="0.7" />
              <path d="M3 38 Q8 35 14 38" stroke="#06d6a0" strokeWidth="1" fill="none" opacity="0.5" />
              <path d="M66 35 Q70 33 74 35" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.7" />
              <path d="M66 38 Q71 35 77 38" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.5" />
              <path d="M66 41 Q72 38 79 41" stroke="#7c3aed" strokeWidth="1" fill="none" opacity="0.4" />
              <path d="M38 22 L40 19 L42 22 L40 21 Z" fill="#fbbf24" opacity="0.8" />
              <circle cx="35" cy="20" r="0.8" fill="#fbbf24" opacity="0.6" />
              <circle cx="45" cy="20" r="0.8" fill="#fbbf24" opacity="0.6" />
              <defs>
                <linearGradient id="boxGrad" x1="20" y1="18" x2="60" y2="55">
                  <stop offset="0%" stopColor="#7c3aed" />
                  <stop offset="50%" stopColor="#06d6a0" />
                  <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="text-4xl font-mono font-bold tracking-tight title-glow">
            <span className="bg-gradient-to-r from-emerald-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">
              Transmoqrify
            </span>
          </h1>
          <p className="text-[11px] font-mono text-gray-500 mt-2 tracking-[0.15em] italic">
            "it's a scientific fact"
          </p>
        </div>

        {!connected ? (
          <div className="card">
            <div className="card-inner space-y-5">
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-mono text-gray-500 mb-2 uppercase tracking-[0.2em]">session_id</label>
                  <input
                    type="text"
                    value={meetingId}
                    onChange={e => setMeetingId(e.target.value)}
                    placeholder="enter session identifier"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-gray-500 mb-2 uppercase tracking-[0.2em]">source_lang</label>
                  <select
                    value={myLanguage}
                    onChange={e => setMyLanguage(e.target.value)}
                    className="select-field"
                  >
                    {LANGUAGES.map(l => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-gray-500 mb-2 uppercase tracking-[0.2em]">mode</label>
                  <div className="flex gap-2">
                    {(['interactive', 'speaker', 'listener'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => setMode(m)}
                        className={mode === m ? 'mode-btn-active' : 'mode-btn-inactive'}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-[10px] font-mono text-gray-600 hover:text-purple-400 transition-colors uppercase tracking-[0.15em]"
                >
                  [{showAdvanced ? '-' : '+'}] advanced
                </button>
                {showAdvanced && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="block text-[10px] font-mono text-gray-600 mb-1 uppercase tracking-wider">relay_host</label>
                      <input
                        type="text"
                        value={serverHost}
                        onChange={e => setServerHost(e.target.value)}
                        className="input-field !text-sm !py-2"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono text-gray-600 mb-1 uppercase tracking-wider">port</label>
                      <input
                        type="text"
                        value={serverPort}
                        onChange={e => setServerPort(e.target.value)}
                        className="input-field !text-sm !py-2"
                      />
                    </div>
                  </div>
                )}
              </div>

              <button onClick={handleJoin} className="btn-primary">
                Connect
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Session bar */}
            <div className="card-glow">
              <div className="card-glow-inner p-4 flex items-center justify-between">
                <div className="font-mono text-sm space-x-2">
                  <span className="text-gray-600">$</span>
                  <span className="text-emerald-400">{meetingId}</span>
                  <span className="text-gray-700">::</span>
                  <span className="text-purple-400">{myLanguage}</span>
                  <span className="text-gray-700">::</span>
                  <span className="text-blue-400">{mode}</span>
                </div>
                <button onClick={handleLeave} className="btn-danger">
                  kill
                </button>
              </div>
            </div>

            {/* Mic */}
            {mode !== 'listener' && (
              <div className="flex justify-center py-4">
                <button
                  onClick={handleToggleMic}
                  className={publishing ? 'mic-on' : 'mic-off'}
                >
                  <span className="font-mono text-base tracking-wider">
                    {publishing ? 'TX' : 'MIC'}
                  </span>
                </button>
              </div>
            )}

            {/* Stats */}
            <div className="stats-bar">
              tx:{audioStats.sent} / rx:{audioStats.received}
              {participants.length > 0 && ` / peers:${participants.length}`}
            </div>

            {/* Transcript panes */}
            {participantIds.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {participantIds.map(pid => {
                  const entries = transcriptsByParticipant[pid] || [];
                  const isMe = pid.includes(myParticipantId) || pid.includes(`participant-${myLanguage}`);
                  const displayName = isMe ? 'self' : pid.replace('participant-', '').replace('virtual-listener-', '');

                  return (
                    <div key={pid} className="transcript-pane">
                      <div className="transcript-pane-inner">
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/5">
                          <span className={`w-2 h-2 rounded-full ${isMe
                            ? 'bg-emerald-400 shadow-[0_0_8px_rgba(6,214,160,0.6)]'
                            : 'bg-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.6)]'
                          }`} />
                          <h3 className="text-[11px] font-mono text-gray-400 uppercase tracking-[0.15em]">
                            {displayName}
                          </h3>
                        </div>
                        <div className="max-h-52 overflow-y-auto space-y-2 flex flex-col-reverse">
                          {[...entries].reverse().map((t, i) => (
                            <div key={i} className={`transcript-text ${t.isFinal ? 'text-gray-200' : 'text-gray-500 italic'}`}>
                              <span className={t.isTranslation ? 'lang-tag-translated' : 'lang-tag-source'}>
                                {t.language}
                              </span>
                              <span className="ml-2">{t.text}</span>
                            </div>
                          ))}
                          {entries.length === 0 && (
                            <div className="text-[11px] font-mono text-gray-700 italic">
                              awaiting speech...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div ref={transcriptEndRef} />
          </>
        )}

        {/* Status */}
        <div className="status-bar">
          <span className="text-emerald-600">&gt;</span> {status}
        </div>

        {moqInfo && showAdvanced && (
          <div className="text-[10px] font-mono text-gray-700 text-center tracking-wide">
            relay={moqInfo.relayUrl} ns={moqInfo.namespacePrefix.join('/')} sid={moqInfo.sessionId}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
