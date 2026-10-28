import { useEffect, useRef, useState } from 'react';
import { GlassPanel } from '@moq-web/app-kit';
import { GOOGLE_CLIENT_ID, googleLogin, guestLogin, type MoatSession } from '../moat';

interface GoogleIdApi {
  initialize(opts: { client_id: string; callback: (r: { credential: string }) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
declare global {
  interface Window { google?: { accounts: { id: GoogleIdApi } } }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiLoading: Promise<GoogleIdApi> | null = null;

function loadGoogleIdentity(): Promise<GoogleIdApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  gsiLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => (window.google?.accounts?.id
      ? resolve(window.google.accounts.id)
      : reject(new Error('Google Identity Services failed to initialize')));
    script.onerror = () => { gsiLoading = null; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(script);
  });
  return gsiLoading;
}

export interface LoginPanelProps {
  onSignedIn: (session: MoatSession) => void;
}

/** Sign-in gate for C4M mode: Google SSO or a guest account (UUID chosen by moat). */
export function LoginPanel({ onSignedIn }: LoginPanelProps) {
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [guestName, setGuestName] = useState('');
  const [busy, setBusy] = useState<null | 'google' | 'guest'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGoogleIdentity()
      .then((gsi) => {
        if (cancelled || !googleBtnRef.current) return;
        gsi.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: ({ credential }) => {
            setBusy('google');
            setError(null);
            googleLogin(credential)
              .then(onSignedIn)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(null));
          },
        });
        gsi.renderButton(googleBtnRef.current, { theme: 'outline', size: 'large', text: 'signin_with', width: 280 });
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [onSignedIn]);

  const continueAsGuest = async () => {
    setBusy('guest');
    setError(null);
    try {
      onSignedIn(await guestLogin(guestName.trim() || 'studio-guest'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <GlassPanel padding="lg">
      <div className="ak-stack" style={{ gap: 16, maxWidth: 320, margin: '0 auto', alignItems: 'stretch' }}>
        <div>
          <div className="ak-heading">Sign in to join a room</div>
          <div className="ak-subtle" style={{ fontSize: 12 }}>
            This relay requires a CAT. Your token is minted per room after you sign in.
          </div>
        </div>
        <div ref={googleBtnRef} style={{ minHeight: 44 }} />
        <div className="ak-subtle" style={{ fontSize: 11, textAlign: 'center' }}>or</div>
        <div className="ak-row" style={{ gap: 6 }}>
          <input
            className="ak-input"
            placeholder="Display name"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void continueAsGuest(); }}
            maxLength={64}
            style={{ flex: 1 }}
          />
          <button className="ak-btn ak-btn-ghost" onClick={() => void continueAsGuest()} disabled={busy !== null}>
            {busy === 'guest' ? 'Signing in…' : 'Continue as guest'}
          </button>
        </div>
        <div className="ak-subtle" style={{ fontSize: 10 }}>
          Guests can join public rooms only.
        </div>
        {busy === 'google' ? <div className="ak-caption">Signing in with Google…</div> : null}
        {error ? <div className="ak-caption" style={{ color: 'var(--ak-danger)' }}>{error}</div> : null}
      </div>
    </GlassPanel>
  );
}
