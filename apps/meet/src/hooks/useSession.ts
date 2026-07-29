import { useRef, useCallback, useEffect } from 'react';
import { MOQTransport } from '@moq-web/core';
import { MOQTSession } from '@moq-web/session';
import { useStore } from '../store';
import { selectFastestRelay } from '../lib/relay-select';

export function useSession() {
  const sessionRef = useRef<MOQTSession | null>(null);
  const transportRef = useRef<MOQTransport | null>(null);
  const relayUrl = useStore((s) => s.relayUrl);
  const setRelayUrl = useStore((s) => s.setRelayUrl);

  const connect = useCallback(async () => {
    let url = relayUrl;
    if (url === 'auto') {
      url = await selectFastestRelay();
      setRelayUrl(url);
    }

    const transport = new MOQTransport();
    await transport.connect(url);
    transportRef.current = transport;

    const session = new MOQTSession(transport);
    await session.setup();
    sessionRef.current = session;

    return session;
  }, [relayUrl, setRelayUrl]);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (transportRef.current) {
      transportRef.current.close();
      transportRef.current = null;
    }
  }, []);

  const getSession = useCallback(() => sessionRef.current, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { connect, disconnect, getSession };
}
