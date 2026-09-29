import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SpotifyState, SpotifyStatus } from '../types';

interface Props {
  spotify: SpotifyState | null;
  status: SpotifyStatus | null;
  onSearch: () => void;
  onError: (msg: string) => void;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function NowPlayingBar({ spotify, status, onSearch, onError }: Props) {
  // Interpolate progress locally between server pushes.
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const playing = spotify?.active && spotify.isPlaying;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);

  if (!status?.configured) return null;

  const control = (action: 'pause' | 'resume' | 'next' | 'previous') => {
    if (busy) return;
    setBusy(true);
    api.spotifyControl(action)
      .catch((err) => onError(err.message))
      .finally(() => setBusy(false));
  };

  const track = spotify?.active ? spotify.track : undefined;
  const progressMs = track
    ? Math.min(
        (spotify!.progressMs ?? 0) + (playing ? now - (spotify!.fetchedAt ?? now) : 0),
        track.durationMs,
      )
    : 0;
  const pct = track && track.durationMs > 0 ? (progressMs / track.durationMs) * 100 : 0;

  return (
    <div className="nowplaying-bar">
      <div className="np-progress"><div className="np-progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="np-inner">
        {track ? (
          <>
            {track.image
              ? <img className="np-art" src={track.image} alt="" />
              : <div className="np-art np-art-empty">🎵</div>}
            <div className="np-meta">
              <span className="np-title" title={track.name}>{track.name}</span>
              <span className="np-artist" title={track.artists}>{track.artists}</span>
              <span className="np-time">{fmtTime(progressMs)} / {fmtTime(track.durationMs)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="np-art np-art-empty">🎵</div>
            <div className="np-meta">
              <span className="np-title muted">
                {status.connected ? 'Nothing playing' : 'Spotify not connected'}
              </span>
            </div>
          </>
        )}

        <div className="np-controls">
          {status.connected ? (
            <>
              <button className="np-btn" disabled={busy || !track} onClick={() => control('previous')} aria-label="Previous">⏮</button>
              <button
                className="np-btn np-play"
                disabled={busy || !track}
                onClick={() => control(playing ? 'pause' : 'resume')}
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? '⏸' : '▶'}
              </button>
              <button className="np-btn" disabled={busy || !track} onClick={() => control('next')} aria-label="Next">⏭</button>
              <button className="btn np-search" onClick={onSearch}>🔍 Songs</button>
            </>
          ) : status.canConnect ? (
            <a className="btn primary" href={api.spotifyLoginUrl()}>Connect Spotify</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
