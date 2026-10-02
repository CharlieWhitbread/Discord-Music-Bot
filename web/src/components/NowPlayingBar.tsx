import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import * as ws from '../ws';
import type { SpotifyState, SpotifyStatus } from '../types';

interface Props {
  spotify: SpotifyState | null;
  status: SpotifyStatus | null;
  musicVolume: number;
  queueCount: number;
  onSearch: () => void;
  onQueue: () => void;
  onError: (msg: string) => void;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const VOLUME_THROTTLE_MS = 150;

export default function NowPlayingBar({
  spotify, status, musicVolume, queueCount, onSearch, onQueue, onError,
}: Props) {
  // Interpolate progress locally between server pushes.
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // Optimistic play/pause: flip the UI instantly, reconcile when the
  // server state catches up (or give up after a few seconds).
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => {
    if (optimistic === null) return;
    if (spotify?.isPlaying === optimistic) {
      setOptimistic(null);
      return;
    }
    const timer = window.setTimeout(() => setOptimistic(null), 6000);
    return () => window.clearTimeout(timer);
  }, [optimistic, spotify]);

  const playing = optimistic ?? (spotify?.active && spotify.isPlaying);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);

  // Music volume slider — local while dragging, throttled sends.
  const [vol, setVol] = useState(musicVolume);
  const dragging = useRef(false);
  const lastSent = useRef(0);
  const trailing = useRef<number>();
  useEffect(() => {
    if (!dragging.current) setVol(musicVolume);
  }, [musicVolume]);

  if (!status?.configured) return null;

  const pushVolume = (v: number) => {
    if (!ws.sendVolume(v)) api.spotifyVolume(v).catch(() => {});
  };

  const changeVolume = (v: number) => {
    setVol(v);
    window.clearTimeout(trailing.current);
    if (Date.now() - lastSent.current >= VOLUME_THROTTLE_MS) {
      lastSent.current = Date.now();
      pushVolume(v);
    } else {
      trailing.current = window.setTimeout(() => {
        lastSent.current = Date.now();
        pushVolume(v);
      }, VOLUME_THROTTLE_MS);
    }
  };

  const toggle = () => {
    const action = playing ? 'pause' : 'resume';
    setOptimistic(!playing); // instant UI flip
    if (!ws.sendSpotifyTransport(action)) {
      api.spotifyControl(action).catch((err) => {
        setOptimistic(null);
        onError(err.message);
      });
    }
  };

  const skip = (action: 'next' | 'previous') => {
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
              <button className="np-btn" disabled={busy || !track} onClick={() => skip('previous')} aria-label="Previous">⏮</button>
              <button
                className="np-btn np-play"
                disabled={!track}
                onClick={toggle}
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? '⏸' : '▶'}
              </button>
              <button className="np-btn" disabled={busy || !track} onClick={() => skip('next')} aria-label="Next">⏭</button>
              <div className="np-volume" title="Music volume (clips unaffected)">
                <span aria-hidden="true">🔉</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={vol}
                  aria-label="Music volume"
                  onPointerDown={() => { dragging.current = true; }}
                  onPointerUp={() => { dragging.current = false; }}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                />
              </div>
              <button className="btn np-queue" onClick={onQueue}>
                Queue{queueCount > 0 ? ` (${queueCount})` : ''}
              </button>
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
