import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SpotifyTrack } from '../types';

interface Props {
  onClose: () => void;
  onNotify: (msg: string) => void;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function SpotifySearchModal({ onClose, onNotify }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyUri, setBusyUri] = useState<string | null>(null);
  const debounceRef = useRef<number>();
  const latestQuery = useRef('');

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    const q = query.trim();
    latestQuery.current = q;
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = window.setTimeout(() => {
      api.spotifySearch(q)
        .then((tracks) => {
          // Ignore responses that arrive after the query changed.
          if (latestQuery.current === q) setResults(tracks);
        })
        .catch((err) => onNotify(err.message))
        .finally(() => {
          if (latestQuery.current === q) setSearching(false);
        });
    }, 350);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, onNotify]);

  const act = (track: SpotifyTrack, mode: 'play' | 'queue') => {
    setBusyUri(track.uri);
    const call = mode === 'play' ? api.spotifyPlay(track.uri) : api.spotifyQueue(track.uri);
    call
      .then(() => {
        if (mode === 'queue') onNotify(`Added to queue: ${track.name}`);
        else onClose();
      })
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyUri(null));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal spotify-search" onClick={(e) => e.stopPropagation()}>
        <h2>Play a song</h2>
        <input
          type="search"
          className="search-input"
          placeholder="Search Spotify…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="track-results">
          {searching && results.length === 0 && <p className="muted">Searching…</p>}
          {!searching && query.trim() && results.length === 0 && <p className="muted">No results</p>}
          {results.map((track) => (
            <div key={track.uri} className="track-row">
              {track.image
                ? <img className="track-art" src={track.image} alt="" />
                : <div className="track-art track-art-empty">🎵</div>}
              <div className="track-meta">
                <span className="track-name" title={track.name}>{track.name}</span>
                <span className="track-artist" title={track.artists}>
                  {track.artists} · {fmtDuration(track.durationMs)}
                </span>
              </div>
              <div className="track-actions">
                <button
                  className="btn primary"
                  disabled={busyUri === track.uri}
                  onClick={() => act(track, 'play')}
                >
                  ▶ Play
                </button>
                <button
                  className="btn"
                  disabled={busyUri === track.uri}
                  onClick={() => act(track, 'queue')}
                >
                  + Queue
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
