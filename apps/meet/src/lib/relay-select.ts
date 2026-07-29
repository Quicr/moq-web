const RELAYS = [
  'https://relay.mocha-net.dev',
  'https://relay-eu.mocha-net.dev',
];

async function measureRtt(url: string, signal: AbortSignal): Promise<{ url: string; rtt: number }> {
  const start = performance.now();
  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal });
  } catch {
    // Connection refused/reset still measures network RTT
  }
  const rtt = performance.now() - start;
  return { url, rtt };
}

export async function selectFastestRelay(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const results = await Promise.allSettled(
      RELAYS.map((url) => measureRtt(url, controller.signal))
    );

    let best = RELAYS[0];
    let bestRtt = Infinity;

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.rtt < bestRtt) {
        bestRtt = result.value.rtt;
        best = result.value.url;
      }
    }

    return best;
  } catch {
    return RELAYS[0];
  } finally {
    clearTimeout(timeout);
  }
}

export { RELAYS };
