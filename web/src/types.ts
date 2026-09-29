export interface Clip {
  id: number;
  name: string;
  emoji: string | null;
  color: string | null;
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
