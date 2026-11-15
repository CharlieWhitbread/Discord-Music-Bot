import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SpotifyTrack } from './types';

/** Debounced Spotify track search; ignores responses for stale queries. */
export function useSpotifySearch(query: string, onError: (msg: string) => void) {
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const latestQuery = useRef('');

  useEffect(() => {
    const q = query.trim();
    latestQuery.current = q;
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.spotifySearch(q)
        .then((tracks) => {
          if (latestQuery.current === q) setResults(tracks);
        })
        .catch((err) => onError(err.message))
        .finally(() => {
          if (latestQuery.current === q) setSearching(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, onError]);

  return { results, searching };
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
