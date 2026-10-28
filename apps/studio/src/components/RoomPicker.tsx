import { useCallback, useEffect, useRef, useState } from 'react';
import { GlassPanel } from '@moq-web/app-kit';
import {
  createStudioRoom,
  listStudioRooms,
  MoatAuthError,
  type MoatSession,
  type RoomVisibility,
  type StudioRoom,
} from '../moat';

export interface RoomPickerProps {
  session: MoatSession;
  selected: StudioRoom | null;
  /** Room currently joined (live), if any — picking another room switches to it. */
  liveRoomId: string | null;
  /** Slug from `?room=` to preselect once the list loads. */
  initialSlug: string | null;
  disabled: boolean;
  onSelect: (room: StudioRoom) => void;
  onSignOut: () => void;
}

/** Room directory for C4M mode: pick an existing studio room or create one. */
export function RoomPicker({ session, selected, liveRoomId, initialSlug, disabled, onSelect, onSignOut }: RoomPickerProps) {
  const isGuest = session.provider === 'guest';
  const [rooms, setRooms] = useState<StudioRoom[] | null>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preselect the `?room=` slug once, on the first list load only.
  const preselectRef = useRef(initialSlug);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await listStudioRooms();
      setRooms(list);
      const slug = preselectRef.current;
      preselectRef.current = null;
      const match = slug ? list.find((r) => r.slug === slug) : undefined;
      if (match && !(isGuest && match.visibility === 'authenticated')) onSelect(match);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [isGuest, onSelect]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const room = await createStudioRoom(session, name, visibility);
      setName('');
      setRooms((cur) => [room, ...(cur ?? [])]);
      onSelect(room);
    } catch (err) {
      if (err instanceof MoatAuthError) onSignOut();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const joinable = (r: StudioRoom) => !(isGuest && r.visibility === 'authenticated');

  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 10 }}>
        <div>
          <div className="ak-heading">Rooms</div>
          <div className="ak-subtle" style={{ fontSize: 11 }}>
            Signed in as <b>{session.displayName}</b>
            {isGuest ? ' (guest)' : ` · ${session.email}`}
          </div>
        </div>
        <div className="ak-row" style={{ gap: 6 }}>
          <button className="ak-btn ak-btn-ghost" onClick={() => void refresh()} disabled={disabled}>Refresh</button>
          <button className="ak-btn ak-btn-ghost" onClick={onSignOut} disabled={disabled}>Sign out</button>
        </div>
      </div>

      {error ? <div className="ak-caption" style={{ color: 'var(--ak-danger)', marginBottom: 8 }}>{error}</div> : null}

      <div className="ak-stack" style={{ gap: 4, maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
        {rooms === null ? (
          <div className="ak-caption">Loading rooms…</div>
        ) : rooms.length === 0 ? (
          <div className="ak-caption">No rooms yet — create one below.</div>
        ) : rooms.map((r) => {
          const active = selected?.id === r.id;
          const ok = joinable(r);
          return (
            <button
              key={r.id}
              className="ak-row-between"
              onClick={() => onSelect(r)}
              disabled={disabled || !ok}
              title={!ok ? 'Sign in with Google to join this room'
                : liveRoomId && liveRoomId !== r.id ? `Switch to ${r.name}` : `Namespace ${r.namespace_prefix}`}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: `1px solid ${active ? 'var(--ak-accent)' : 'var(--ak-border)'}`,
                background: active ? 'var(--ak-accent-soft)' : 'transparent',
                color: 'var(--ak-fg)',
                textAlign: 'left',
                cursor: disabled || !ok ? 'default' : 'pointer',
                opacity: ok ? 1 : 0.5,
              }}
            >
              <span>{r.name} <span className="ak-subtle" style={{ fontSize: 10 }}>/{r.slug}</span></span>
              <span className="ak-row" style={{ gap: 4 }}>
                {liveRoomId === r.id ? <span className="ak-chip ak-chip-success" style={{ fontSize: 10 }}>live</span> : null}
                <span className="ak-chip ak-chip-neutral" style={{ fontSize: 10 }}>
                  {r.visibility === 'authenticated' ? 'sign-in only' : 'public'}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="ak-row" style={{ gap: 6 }}>
        <input
          className="ak-input"
          placeholder="New room name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create(); }}
          disabled={disabled || busy}
          style={{ flex: 1 }}
        />
        <select
          className="ak-input"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as RoomVisibility)}
          disabled={disabled || busy || isGuest}
          title={isGuest ? 'Guests can only create public rooms' : 'Who may join'}
          style={{ width: 'auto' }}
        >
          <option value="public">Public</option>
          <option value="authenticated">Sign-in only</option>
        </select>
        <button className="ak-btn ak-btn-primary" onClick={() => void create()} disabled={disabled || busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </GlassPanel>
  );
}
