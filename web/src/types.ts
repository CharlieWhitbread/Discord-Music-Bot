export interface Clip {
  id: number;
  name: string;
  emoji: string | null;
  color: string | null;
  tags: string[];
  durationMs: number;
  uploaderId: string;
  uploaderName: string;
  playCount: number;
  createdAt: number;
}

export interface User {
  userId: string;
  username: string;
  avatar: string | null;
}

export interface BotStatus {
  inVoice: boolean;
  clip: { id: number; name: string } | null;
  spotifyActive: boolean;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string;
  album: string;
  image: string | null;
  durationMs: number;
}

export interface SpotifyState {
  active: boolean;
  isPlaying?: boolean;
  progressMs?: number;
  fetchedAt?: number;
  onOurDevice?: boolean;
  track?: SpotifyTrack;
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  canConnect: boolean;
}
