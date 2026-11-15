/**
 * Persistent WebSocket to the Pi — the primary press-to-sound channel
 * (one hot round trip instead of a TLS handshake per press). Falls back
 * to HTTP POST in api.ts when the socket is down.
 */

import { WS_URL } from './config';
import { getToken } from './auth';
import type { BotStatus, ConnectionState, Playlist, QueueEntry, SpotifyState, YouTubeState } from './types';

type Listener = {
  onStatus?: (status: BotStatus) => void;
  onState?: (state: ConnectionState) => void;
  onError?: (error: string) => void;
  onSpotify?: (spotify: SpotifyState) => void;
  onQueue?: (queue: QueueEntry[]) => void;
  onPlaylists?: (playlists: Playlist[]) => void;
  /** clockOffset = server clock − local clock, in ms */
  onYoutube?: (youtube: YouTubeState, clockOffset: number) => void;
};

let socket: WebSocket | null = null;
let listeners: Listener[] = [];
let reconnectDelay = 1000;
let reconnectTimer: number | undefined;
let state: ConnectionState = 'closed';

function setState(next: ConnectionState) {
  state = next;
  listeners.forEach((l) => l.onState?.(next));
}

export function connect(): void {
  if (socket || !getToken()) return;
  setState('connecting');
  const ws = new WebSocket(WS_URL);
  socket = ws;
  // Handlers ignore a socket that has been replaced: after disconnect() +
  // connect() (React StrictMode remount) the old one closes late, and its
  // onclose used to null the new socket and schedule a duplicate.
  const current = () => socket === ws;

  ws.onopen = () => {
    if (current()) ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
  };

  ws.onmessage = (event) => {
    if (!current()) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'auth' && msg.ok) {
      reconnectDelay = 1000;
      setState('open');
    } else if (msg.type === 'status') {
      listeners.forEach((l) => l.onStatus?.(msg.status));
    } else if (msg.type === 'spotify') {
      listeners.forEach((l) => l.onSpotify?.(msg.spotify));
    } else if (msg.type === 'queue') {
      listeners.forEach((l) => l.onQueue?.(msg.queue));
    } else if (msg.type === 'playlists') {
      listeners.forEach((l) => l.onPlaylists?.(msg.playlists));
    } else if (msg.type === 'youtube') {
      const offset = typeof msg.serverNow === 'number' ? msg.serverNow - Date.now() : 0;
      listeners.forEach((l) => l.onYoutube?.(msg.youtube, offset));
    } else if (msg.type === 'error') {
      listeners.forEach((l) => l.onError?.(msg.error));
    }
  };

  ws.onclose = () => {
    if (!current()) return;
    socket = null;
    setState('closed');
    if (getToken()) {
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  };

  ws.onerror = () => ws.close();
}

export function disconnect(): void {
  window.clearTimeout(reconnectTimer);
  const old = socket;
  socket = null;
  old?.close();
  // The old socket's onclose is ignored now, so report the state here.
  if (state !== 'closed') setState('closed');
}

export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  listener.onState?.(state);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** @returns true if sent over the socket; caller falls back to HTTP otherwise. */
export function sendPlay(clipId: number): boolean {
  if (socket?.readyState === WebSocket.OPEN && state === 'open') {
    socket.send(JSON.stringify({ type: 'play', clipId }));
    return true;
  }
  return false;
}

export function sendStop(): boolean {
  if (socket?.readyState === WebSocket.OPEN && state === 'open') {
    socket.send(JSON.stringify({ type: 'stop' }));
    return true;
  }
  return false;
}

/** Pause/resume over the hot socket for instant-feel transport. */
export function sendSpotifyTransport(action: 'pause' | 'resume'): boolean {
  if (socket?.readyState === WebSocket.OPEN && state === 'open') {
    socket.send(JSON.stringify({ type: `spotify:${action}` }));
    return true;
  }
  return false;
}

export function sendVolume(value: number): boolean {
  if (socket?.readyState === WebSocket.OPEN && state === 'open') {
    socket.send(JSON.stringify({ type: 'volume', value }));
    return true;
  }
  return false;
}

export type YouTubeCommand =
  | { type: 'yt:load' | 'yt:enqueue'; videoId: string }
  | { type: 'yt:play' | 'yt:pause' | 'yt:seek'; position: number }
  | { type: 'yt:dequeue'; id: number }
  | { type: 'yt:ended'; videoId: string }
  | { type: 'yt:meta'; videoId: string; duration: number }
  | { type: 'yt:skip' | 'yt:clear' };

/** Watch-together is socket-only: sync is meaningless without a live connection. */
export function sendYoutube(command: YouTubeCommand): boolean {
  if (socket?.readyState === WebSocket.OPEN && state === 'open') {
    socket.send(JSON.stringify(command));
    return true;
  }
  return false;
}
