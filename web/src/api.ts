import { API_BASE } from './config';
import { clearToken, getToken } from './auth';
import type { BotStatus, Clip, Playlist, QueueEntry, SpotifyStatus, SpotifyTrack, User } from './types';

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    // Only force a re-login when a (now stale) token existed.
    if (token) {
      clearToken();
      window.location.reload();
    }
    throw new ApiError('Not authenticated', 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  loginUrl: `${API_BASE}/api/auth/login`,
  me: () => request<User>('/api/auth/me'),
  clips: () => request<Clip[]>('/api/clips'),
  status: () => request<BotStatus>('/api/status'),
  play: (clipId: number) => request<{ ok: true }>(`/api/play/${clipId}`, { method: 'POST' }),
  stop: () => request<{ ok: true }>('/api/stop', { method: 'POST' }),
  deleteClip: (clipId: number) => request<void>(`/api/clips/${clipId}`, { method: 'DELETE' }),
  favorites: () => request<number[]>('/api/clips/favorites'),
  setFavorite: (clipId: number, favorite: boolean) =>
    request<number[]>(`/api/clips/${clipId}/favorite`, { method: favorite ? 'PUT' : 'DELETE' }),
  updateClip: (clipId: number, fields: { name?: string; emoji?: string; tags?: string }) =>
    request<Clip>(`/api/clips/${clipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  clipAudioUrl: (clipId: number) => `${API_BASE}/api/clips/${clipId}/audio`,
  upload: (form: FormData) =>
    request<Clip>('/api/clips', { method: 'POST', body: form }),

  /* ── Spotify jukebox ── */
  spotifyStatus: () => request<SpotifyStatus>('/api/spotify/status'),
  // Browser navigation can't send headers, so the bearer token rides in the query.
  spotifyLoginUrl: () => `${API_BASE}/api/spotify/login?token=${encodeURIComponent(getToken() ?? '')}`,
  spotifySearch: (q: string) =>
    request<SpotifyTrack[]>(`/api/spotify/search?q=${encodeURIComponent(q)}`),
  spotifyPlay: (uri: string) =>
    request<{ ok: true }>('/api/spotify/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    }),
  spotifyQueue: (uri: string) =>
    request<QueueEntry>('/api/spotify/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    }),
  spotifyQueueList: () => request<QueueEntry[]>('/api/spotify/queue'),
  spotifyQueueRemove: (id: number) =>
    request<{ ok: true }>(`/api/spotify/queue/${id}`, { method: 'DELETE' }),
  spotifyVolume: (value: number) =>
    request<{ ok: true; value: number }>('/api/spotify/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }),
  spotifyControl: (action: 'pause' | 'resume' | 'next' | 'previous') =>
    request<{ ok: true }>(`/api/spotify/${action}`, { method: 'POST' }),

  /* ── web-app playlists ── */
  playlists: () => request<Playlist[]>('/api/spotify/playlists'),
  createPlaylist: (fields: PlaylistFields) =>
    request<Playlist>('/api/spotify/playlists', json('POST', fields)),
  updatePlaylist: (id: number, fields: Partial<PlaylistFields>) =>
    request<Playlist>(`/api/spotify/playlists/${id}`, json('PATCH', fields)),
  deletePlaylist: (id: number) =>
    request<void>(`/api/spotify/playlists/${id}`, { method: 'DELETE' }),
  playlistTracks: (id: number) =>
    request<SpotifyTrack[]>(`/api/spotify/playlists/${id}/tracks`),
  addPlaylistTrack: (id: number, uri: string) =>
    request<SpotifyTrack>(`/api/spotify/playlists/${id}/tracks`, json('POST', { uri })),
  removePlaylistTrack: (id: number, uri: string) =>
    request<{ ok: true }>(`/api/spotify/playlists/${id}/tracks`, json('DELETE', { uri })),
  playPlaylist: (id: number) =>
    request<{ ok: true }>(`/api/spotify/playlists/${id}/play`, { method: 'POST' }),
};

export interface PlaylistFields {
  name: string;
  emoji: string;
  tags: string;
  shuffle: boolean;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export { ApiError };
