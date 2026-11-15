/**
 * Thin wrapper over the YouTube IFrame Player API. Typed by hand to avoid
 * pulling in @types/youtube for the handful of calls we use.
 */

export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string; title?: string; author?: string };
  setVolume(volume: number): void;
  getVolume(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Failed to load the YouTube player'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Accepts watch/short/embed/live/youtu.be URLs or a bare 11-char id. */
export function parseVideoId(input: string): string | null {
  const text = input.trim();
  if (ID_RE.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    if (!id) {
      const [, kind, value] = url.pathname.split('/');
      if (['shorts', 'embed', 'live', 'v'].includes(kind)) id = value ?? null;
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/** Player error codes → human messages (see IFrame API onError). */
export function describePlayerError(code: number): string {
  if (code === 2) return 'Invalid video id';
  if (code === 5) return 'This video can’t be played in the HTML5 player';
  if (code === 100) return 'Video not found (removed or private)';
  if (code === 101 || code === 150) return 'The owner doesn’t allow this video to be embedded';
  return `YouTube player error (${code})`;
}
