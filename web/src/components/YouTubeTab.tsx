import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import * as ws from '../ws';
import type { YouTubeState } from '../types';
import { PlayerState, YTPlayer, describePlayerError, loadYouTubeApi, parseVideoId } from '../youtube';

interface Props {
  shared: YouTubeState | null;
  clockOffset: number;
  connected: boolean;
  onNotify: (msg: string) => void;
}

/* Drift policy: small drift is nudged with playback rate so nobody sees a
   jump; large drift (buffering, late join, tab throttling) hard-seeks. */
const HARD_SEEK_S = 1.5;
const NUDGE_S = 0.3;
const DRIFT_CHECK_MS = 1000;
/* Programmatic player calls fire onStateChange too — ignore events for this
   long after we act, or every client would echo every command back. */
const SUPPRESS_MS = 1200;
/* If we should be playing but aren't for this long, the browser probably
   blocked autoplay — ask for a click. */
const GESTURE_TIMEOUT_MS = 3000;
const SKIP_S = 10;
const VOLUME_KEY = 'yt_volume';
const DOUBLE_CLICK_MS = 250;
const CONTROLS_IDLE_MS = 2500;

/* Safari still only ships the prefixed Fullscreen API on some versions. */
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };

function FullscreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      {exit
        ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function describeAction(state: YouTubeState): string | null {
  if (state.action === 'ended') return 'Finished — queue something up';
  if (!state.by || !state.action) return null;
  const who = state.by.username;
  switch (state.action) {
    case 'load': return `${who} started this video`;
    case 'play': return `${who} pressed play`;
    case 'pause': return `${who} paused`;
    case 'seek': return `${who} skipped to ${fmt(state.position)}`;
    case 'skip': return `${who} skipped to the next video`;
    case 'advance': return `Up next, queued by ${who}`;
    case 'enqueue': return `${who} added a video to the queue`;
    default: return null;
  }
}

function thumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export default function YouTubeTab({ shared, clockOffset, connected, onNotify }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const sharedRef = useRef<YouTubeState | null>(shared);
  const offsetRef = useRef(clockOffset);
  const suppressUntil = useRef(0);
  const lastState = useRef<number>(PlayerState.UNSTARTED);
  const notPlayingSince = useRef<number | null>(null);
  /** videoId whose duration we've already reported to the server */
  const reportedDuration = useRef<string | null>(null);

  const [input, setInput] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(VOLUME_KEY) ?? 100));
  /** 'native' = Fullscreen API; 'pseudo' = fixed full-viewport fallback (iPhone Safari). */
  const [fullscreen, setFullscreen] = useState<'native' | 'pseudo' | null>(null);
  const [idle, setIdle] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<number>();
  const clickTimer = useRef<number>();

  sharedRef.current = shared;
  offsetRef.current = clockOffset;

  /** Where the shared timeline is right now, in seconds. */
  const expectedPosition = useCallback((): number => {
    const s = sharedRef.current;
    if (!s) return 0;
    if (!s.playing) return s.position;
    const serverNow = Date.now() + offsetRef.current;
    return s.position + Math.max(0, serverNow - s.updatedAt) / 1000;
  }, []);

  const suppress = () => { suppressUntil.current = Date.now() + SUPPRESS_MS; };

  /** Bring the local player in line with the shared state. */
  const apply = useCallback(() => {
    const player = playerRef.current;
    const s = sharedRef.current;
    if (!player || !readyRef.current || !s) return;

    if (!s.videoId) {
      const st = player.getPlayerState();
      if (st === PlayerState.PLAYING || st === PlayerState.BUFFERING) {
        suppress();
        player.pauseVideo();
      }
      return;
    }

    const target = expectedPosition();
    if (player.getVideoData().video_id !== s.videoId) {
      suppress();
      if (s.playing) player.loadVideoById({ videoId: s.videoId, startSeconds: target });
      else player.cueVideoById({ videoId: s.videoId, startSeconds: target });
      return;
    }

    const st = player.getPlayerState();
    const localPlaying = st === PlayerState.PLAYING || st === PlayerState.BUFFERING;
    if (Math.abs(player.getCurrentTime() - target) > (s.playing ? HARD_SEEK_S : 0.5)) {
      suppress();
      player.seekTo(target, true);
    }
    if (s.playing && !localPlaying) {
      suppress();
      player.playVideo();
    } else if (!s.playing && localPlaying) {
      suppress();
      player.pauseVideo();
    }
  }, [expectedPosition]);

  /* ─── player lifecycle ─── */
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    // YT.Player replaces its host element — give it one React doesn't own.
    const host = document.createElement('div');
    container.appendChild(host);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        const initial = sharedRef.current;
        playerRef.current = new YT.Player(host, {
          // An explicit undefined videoId throws "Invalid video id".
          ...(initial?.videoId ? { videoId: initial.videoId } : {}),
          playerVars: {
            // Custom controls only: native seek/keyboard would bypass sync.
            controls: 0,
            disablekb: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              readyRef.current = true;
              e.target.setVolume(volume);
              apply();
            },
            onStateChange: (e) => onStateChange(e.data, e.target),
            onError: (e) => onNotify(describePlayerError(e.data)),
          },
        });
      })
      .catch((err: Error) => setApiError(err.message));

    return () => {
      cancelled = true;
      readyRef.current = false;
      playerRef.current?.destroy();
      playerRef.current = null;
      container.innerHTML = '';
    };
    // Player is created once; handlers read latest state via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Turns clicks on the video itself into shared commands. */
  function onStateChange(next: number, player: YTPlayer) {
    const prev = lastState.current;
    // Resuming goes PAUSED → BUFFERING → PLAYING; remembering BUFFERING as
    // "prev" hid the resume and it was never shared.
    if (next !== PlayerState.BUFFERING) lastState.current = next;

    if (next === PlayerState.PLAYING) {
      setNeedsGesture(false);
      const data = player.getVideoData();
      setTitle(data.title || null);
      setDuration(player.getDuration() || 0);
    }
    if (next === PlayerState.CUED) {
      setDuration(player.getDuration() || 0);
      setTitle(player.getVideoData().title || null);
    }

    // Report the end even during suppression — the server keeps only the
    // first report for the current video and advances the queue.
    const current = sharedRef.current;
    if (next === PlayerState.ENDED && current?.videoId && player.getVideoData().video_id === current.videoId) {
      ws.sendYoutube({ type: 'yt:ended', videoId: current.videoId });
    }

    if (Date.now() < suppressUntil.current) return;
    const s = sharedRef.current;
    if (!s?.videoId) return;

    // Mobile browsers pause media when backgrounded — don't pause everyone.
    if (next === PlayerState.PAUSED && prev === PlayerState.PLAYING && s.playing && !document.hidden) {
      ws.sendYoutube({ type: 'yt:pause', position: player.getCurrentTime() });
    } else if (
      next === PlayerState.PLAYING &&
      !s.playing &&
      (prev === PlayerState.PAUSED || prev === PlayerState.CUED)
    ) {
      ws.sendYoutube({ type: 'yt:play', position: player.getCurrentTime() });
    }
  }

  /* Re-sync whenever the shared state (or clock estimate) changes. */
  useEffect(() => {
    if (!shared?.videoId) {
      setTitle(null);
      setDuration(0);
      setNeedsGesture(false);
    }
    // Every (re)start resets the server's duration — report it again, even
    // when the same video is played twice in a row.
    if (!shared?.duration && (shared?.action === 'load' || shared?.action === 'advance' || shared?.action === 'skip')) {
      reportedDuration.current = null;
    }
    apply();
  }, [shared, clockOffset, apply]);

  /* ─── drift correction + UI clock ─── */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      const s = sharedRef.current;
      if (!player || !readyRef.current) return;

      setCurrent(player.getCurrentTime() || 0);
      const d = player.getDuration();
      if (d) setDuration(d);
      if (s?.videoId) setTitle(player.getVideoData().title || null);
      // Tell the server the duration once, so it can advance the queue even
      // when nobody has this tab open at the moment the video ends.
      if (
        s?.videoId && !s.duration && d > 0 && reportedDuration.current !== s.videoId &&
        player.getVideoData().video_id === s.videoId
      ) {
        reportedDuration.current = s.videoId;
        ws.sendYoutube({ type: 'yt:meta', videoId: s.videoId, duration: d });
      }

      if (!s?.videoId || Date.now() < suppressUntil.current) return;
      const st = player.getPlayerState();

      if (!s.playing) {
        notPlayingSince.current = null;
        setNeedsGesture(false);
        return;
      }

      if (st !== PlayerState.PLAYING) {
        if (st === PlayerState.ENDED) return;
        if (st === PlayerState.BUFFERING) {
          notPlayingSince.current = null;
          return;
        }
        notPlayingSince.current ??= Date.now();
        if (Date.now() - notPlayingSince.current > GESTURE_TIMEOUT_MS) setNeedsGesture(true);
        else apply();
        return;
      }
      notPlayingSince.current = null;

      const target = expectedPosition();
      const dur = player.getDuration();
      if (dur && target >= dur) return; // shared timeline ran past the end
      const drift = player.getCurrentTime() - target;
      if (Math.abs(drift) > HARD_SEEK_S) {
        suppress();
        player.seekTo(target, true);
      } else if (Math.abs(drift) > NUDGE_S) {
        setRate(player, drift > 0 ? 0.95 : 1.05);
      } else {
        setRate(player, 1);
      }
    }, DRIFT_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [apply, expectedPosition]);

  /* ─── user actions ─── */
  const send = (command: ws.YouTubeCommand) => {
    if (!ws.sendYoutube(command)) onNotify('Not connected to the bot — can’t sync');
  };

  /** Default action: queue it (which starts it if nothing is on). */
  const submit = (e: FormEvent, mode: 'yt:enqueue' | 'yt:load' = 'yt:enqueue') => {
    e.preventDefault();
    const id = parseVideoId(input);
    if (!id) {
      onNotify('That doesn’t look like a YouTube link');
      return;
    }
    send({ type: mode, videoId: id });
    if (mode === 'yt:enqueue' && shared?.videoId) onNotify('Added to the queue');
    setInput('');
  };

  const position = () => playerRef.current?.getCurrentTime() ?? expectedPosition();
  const playing = !!shared?.playing;
  const togglePlay = () => send({ type: playing ? 'yt:pause' : 'yt:play', position: position() });
  const seekTo = (s: number) =>
    send({ type: 'yt:seek', position: Math.max(0, duration ? Math.min(s, duration - 0.5) : s) });

  const commitScrub = () => {
    if (scrub !== null) seekTo(scrub);
    setScrub(null);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    localStorage.setItem(VOLUME_KEY, String(v));
    playerRef.current?.setVolume(v);
  };

  const join = () => {
    setNeedsGesture(false);
    notPlayingSince.current = null;
    playerRef.current?.playVideo();
    apply();
  };

  /* ─── fullscreen: our stage (player + synced controls), never YouTube's ─── */
  const enterFullscreen = () => {
    const el = stageRef.current as FullscreenElement | null;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setFullscreen('pseudo'));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else setFullscreen('pseudo'); // iPhone Safari: no element fullscreen
  };

  const exitFullscreen = () => {
    const doc = document as FullscreenDocument;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.();
    setFullscreen(null);
  };

  const toggleFullscreen = () => (fullscreen ? exitFullscreen() : enterFullscreen());

  useEffect(() => {
    const onChange = () => {
      const doc = document as FullscreenDocument;
      const el = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setFullscreen((cur) => (el && el === stageRef.current ? 'native' : cur === 'pseudo' ? 'pseudo' : null));
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  /* The pseudo mode has no browser-provided Esc, and the page mustn't scroll under it. */
  useEffect(() => {
    if (fullscreen !== 'pseudo') return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(null);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  /* Fullscreen controls fade out after a few idle seconds. */
  const wake = () => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), CONTROLS_IDLE_MS);
  };

  useEffect(() => {
    if (fullscreen) wake();
    else setIdle(false);
    return () => window.clearTimeout(idleTimer.current);
  }, [fullscreen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  /* The shield over the iframe: YouTube's own UI never sees a click, so
     every play/pause goes through the shared state. Single click waits a
     beat so a double click (fullscreen) doesn't pause everyone first. */
  const onShieldClick = () => {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(togglePlay, DOUBLE_CLICK_MS);
  };

  const onShieldDoubleClick = () => {
    window.clearTimeout(clickTimer.current);
    toggleFullscreen();
  };

  const onStageKey = (e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, button, form')) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'f') {
      toggleFullscreen();
    }
  };

  const hasVideo = !!shared?.videoId;
  const shown = scrub ?? current;
  const status = shared ? describeAction(shared) : null;
  const queue = shared?.queue ?? [];
  const canSubmit = connected && !!input.trim();

  return (
    <section className="yt-tab">
      <form className="yt-load" onSubmit={(e) => submit(e)}>
        <input
          type="text"
          className="search-input"
          placeholder={hasVideo ? 'Paste a YouTube link to queue it…' : 'Paste a YouTube link to watch together…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={!canSubmit}>
          {hasVideo ? '+ Queue' : 'Watch'}
        </button>
        {hasVideo && (
          <button className="btn" type="button" disabled={!canSubmit} onClick={(e) => submit(e, 'yt:load')}>
            Play now
          </button>
        )}
      </form>

      <div
        ref={stageRef}
        className={`yt-stage${fullscreen ? ' fullscreen' : ''}${fullscreen === 'pseudo' ? ' pseudo' : ''}${fullscreen && idle && playing ? ' idle' : ''}`}
        tabIndex={-1}
        onKeyDown={onStageKey}
        onPointerMove={fullscreen ? wake : undefined}
        onPointerDown={fullscreen ? wake : undefined}
      >
      <div className="yt-frame">
        <div ref={containerRef} className="yt-player" />
        {hasVideo && (
          <div
            className={`yt-shield${playing ? '' : ' paused'}`}
            role="button"
            aria-label={playing ? 'Pause for everyone' : 'Play for everyone'}
            onClick={onShieldClick}
            onDoubleClick={onShieldDoubleClick}
          >
            {!playing && <span className="yt-shield-icon" aria-hidden="true">▶</span>}
          </div>
        )}
        {!hasVideo && (
          <div className="yt-placeholder">
            <span className="yt-placeholder-icon">📺</span>
            <p>Nothing on yet — paste a link above and everyone here will watch in sync.</p>
            <p className="muted">
              Each person streams from YouTube in their own browser, so sign in to YouTube
              (Premium = no ads). Chat in Discord voice as usual.
            </p>
          </div>
        )}
        {apiError && <div className="yt-placeholder"><p>{apiError}</p></div>}
        {hasVideo && needsGesture && (
          <button className="yt-join" onClick={join}>
            ▶ Click to join the watch party
          </button>
        )}
      </div>

      {hasVideo && (
        <div className="yt-controls">
          <div className="yt-title-row">
            <span className="yt-title" title={shared?.title ?? title ?? undefined}>{shared?.title ?? title ?? 'Loading…'}</span>
            {status && <span className="yt-status muted">{status}</span>}
          </div>
          <input
            type="range"
            className="yt-seek"
            min={0}
            max={Math.max(duration, 1)}
            step={0.5}
            value={Math.min(shown, Math.max(duration, 1))}
            aria-label="Seek"
            disabled={!connected || !duration}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={() => setScrub(null)}
          />
          <div className="yt-buttons">
            <button className="np-btn" disabled={!connected} onClick={() => seekTo(position() - SKIP_S)} aria-label="Back 10 seconds">⏪</button>
            <button className="np-btn np-play" disabled={!connected} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? '⏸' : '▶'}
            </button>
            <button className="np-btn" disabled={!connected} onClick={() => seekTo(position() + SKIP_S)} aria-label="Forward 10 seconds">⏩</button>
            <button
              className="np-btn"
              disabled={!connected || queue.length === 0}
              onClick={() => send({ type: 'yt:skip' })}
              aria-label="Next video"
              title={queue.length ? 'Skip to the next queued video' : 'Nothing queued'}
            >
              ⏭
            </button>
            <span className="np-time">{fmt(shown)} / {fmt(duration)}</span>
            <div className="np-volume yt-volume" title="Your volume (only affects you)">
              <span aria-hidden="true">🔉</span>
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                aria-label="Your YouTube volume"
                onChange={(e) => changeVolume(Number(e.target.value))}
              />
            </div>
            <button className="btn" onClick={apply} title="Snap to the shared position">Resync</button>
            <button className="btn subtle" disabled={!connected} onClick={() => send({ type: 'yt:clear' })}>
              Stop for everyone
            </button>
            <button
              className="np-btn yt-fs-btn"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'}
            >
              <FullscreenIcon exit={!!fullscreen} />
            </button>
          </div>
        </div>
      )}
      </div>

      {queue.length > 0 && (
        <section className="panel yt-queue">
          <div className="panel-header">
            <h2>Up next ({queue.length})</h2>
          </div>
          <div className="track-results">
            {queue.map((entry, i) => (
              <div key={entry.id} className="track-row">
                <span className="queue-pos muted">{i + 1}</span>
                <img className="yt-thumb" src={thumbnail(entry.videoId)} alt="" loading="lazy" />
                <div className="track-meta">
                  <span className="track-name" title={entry.title ?? entry.videoId}>{entry.title ?? entry.videoId}</span>
                  {entry.addedBy && <span className="track-artist">added by {entry.addedBy.username}</span>}
                </div>
                <div className="track-actions">
                  <button
                    className="btn"
                    disabled={!connected}
                    onClick={() => send({ type: 'yt:dequeue', id: entry.id })}
                    aria-label={`Remove ${entry.title ?? entry.videoId}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function setRate(player: YTPlayer, rate: number) {
  if (player.getPlaybackRate() !== rate) player.setPlaybackRate(rate);
}
