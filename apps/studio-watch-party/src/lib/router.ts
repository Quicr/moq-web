import { useEffect, useState } from 'react';

export type Route =
  | { name: 'landing' }
  | { name: 'studio'; roomId: string }
  | { name: 'room'; roomId: string; track?: string };

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === '' || clean === '/') return { name: 'landing' };

  const [pathPart, queryPart] = clean.split('?');
  const path = (pathPart ?? '').split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart ?? '');

  if (path[0] === 'studio') {
    const roomId = query.get('room') ?? path[1] ?? randomRoomId();
    return { name: 'studio', roomId };
  }
  if (path[0] === 'room' && path[1]) {
    const track = query.get('track') ?? undefined;
    return { name: 'room', roomId: path[1], ...(track ? { track } : {}) };
  }
  return { name: 'landing' };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'landing':
      return '#/';
    case 'studio':
      return `#/studio?room=${encodeURIComponent(route.roomId)}`;
    case 'room': {
      const base = `#/room/${encodeURIComponent(route.roomId)}`;
      return route.track ? `${base}?track=${encodeURIComponent(route.track)}` : base;
    }
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeToHash(route).slice(1); // strip leading '#'
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function randomRoomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
