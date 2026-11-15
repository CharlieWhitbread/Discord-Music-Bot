import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Playlist, SpotifyTrack } from '../types';

interface Props {
  track: SpotifyTrack;
  playlists: Playlist[];
  onNotify: (msg: string) => void;
  /** button label; defaults to an icon-only "+ playlist" */
  label?: string;
  className?: string;
}

const MENU_WIDTH = 240;

/**
 * "Add to playlist" button + popover. The menu is position:fixed (placed
 * from the button's rect) so scroll containers in modals can't clip it.
 */
export default function AddToPlaylistMenu({ track, playlists, onNotify, label = '+ Playlist', className = 'btn' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setPos(openUp
      ? { left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(320, spaceAbove) }
      : { left, top: rect.bottom + 6, maxHeight: Math.min(320, spaceBelow) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      // resize targets window, which isn't a Node — contains() would throw.
      const target = e.target instanceof Node ? e.target : null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    // Any scroll moves the button away from the fixed menu — just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const add = (playlist: Playlist) => {
    setBusyId(playlist.id);
    api.addPlaylistTrack(playlist.id, track.uri)
      .then(() => {
        setAdded((cur) => new Set(cur).add(playlist.id));
        onNotify(`Added to ${playlist.emoji ?? '🎵'} ${playlist.name}`);
      })
      .catch((err) => {
        // Already there counts as success for the checkmark.
        if (err.status === 409) setAdded((cur) => new Set(cur).add(playlist.id));
        onNotify(err.message);
      })
      .finally(() => setBusyId(null));
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Add "${track.name}" to a playlist`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          className="playlist-menu"
          role="menu"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: MENU_WIDTH, maxHeight: pos.maxHeight }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="playlist-menu-title">Add to playlist</div>
          {playlists.length === 0 && (
            <p className="muted playlist-menu-empty">No playlists yet — create one on the Spotify tab.</p>
          )}
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              role="menuitem"
              className="playlist-menu-item"
              disabled={busyId === playlist.id || added.has(playlist.id)}
              onClick={() => add(playlist)}
            >
              <span aria-hidden="true">{playlist.emoji ?? '🎵'}</span>
              <span className="playlist-menu-name">{playlist.name}</span>
              <span className="muted">{added.has(playlist.id) ? '✓' : busyId === playlist.id ? '…' : playlist.trackCount}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
