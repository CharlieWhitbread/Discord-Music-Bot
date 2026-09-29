/**
 * Persistent WebSocket to the Pi — the primary press-to-sound channel
 * (one hot round trip instead of a TLS handshake per press). Falls back
 * to HTTP POST in api.ts when the socket is down.
 */

import { WS_URL } from './config';
import { getToken } from './auth';
import type { BotStatus, ConnectionState, SpotifyState } from './types';

type Listener = {
  onStatus?: (status: BotStatus) => void;
  onState?: (state: ConnectionState) => void;
  onError?: (error: string) => void;
  onSpotify?: (spotify: SpotifyState) => void;
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
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    socket?.send(JSON.stringify({ type: 'auth', token: getToken() }));
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'auth' && msg.ok) {
      reconnectDelay = 1000;
      setState('open');
    } else if (msg.type === 'status') {
      listeners.forEach((l) => l.onStatus?.(msg.status));
    } else if (msg.type === 'spotify') {
      listeners.forEach((l) => l.onSpotify?.(msg.spotify));
    } else if (msg.type === 'error') {
      listeners.forEach((l) => l.onError?.(msg.error));
    }
  };

  socket.onclose = () => {
    socket = null;
    setState('closed');
    if (getToken()) {
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  };

  socket.onerror = () => socket?.close();
}

export function disconnect(): void {
  window.clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
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
