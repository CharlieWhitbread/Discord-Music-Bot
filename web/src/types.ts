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
  musicVolume?: number;
  musicMuted?: boolean;
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
  shuffle?: boolean;
  context?: { type: string; uri: string } | null;
  track?: SpotifyTrack;
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  canConnect: boolean;
  /** false until an admin re-links Spotify with the playlist scopes */
  playlists: boolean;
}

export interface QueueEntry {
  id: number;
  track: SpotifyTrack;
  addedBy: { userId: string; username: string };
  addedAt: number;
  /** already handed to Spotify — plays next, can't be removed */
  locked?: boolean;
}

export interface Playlist {
  id: number;
  spotifyId: string;
  name: string;
  emoji: string | null;
  tags: string[];
  shuffle: boolean;
  trackCount: number;
  creatorId: string;
  creatorName: string;
  playCount: number;
  createdAt: number;
}

export interface QueuedVideo {
  id: number;
  videoId: string;
  title: string | null;
  addedBy: { userId: string; username: string } | null;
  addedAt: number;
}

/** Shared watch-together state; position is in seconds as of updatedAt (server clock). */
export interface YouTubeState {
  videoId: string | null;
  title: string | null;
  /** seconds, once a viewer's player has reported it */
  duration: number | null;
  playing: boolean;
  position: number;
  updatedAt: number;
  by: { userId: string; username: string } | null;
  action: 'load' | 'play' | 'pause' | 'seek' | 'clear' | 'enqueue' | 'dequeue' | 'skip' | 'advance' | 'ended' | null;
  queue: QueuedVideo[];
}

export type TabId = 'soundboard' | 'spotify' | 'youtube';
