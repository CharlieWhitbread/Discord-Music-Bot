import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
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
/* YouTube fires no seek event, so the player is sampled this often to spot
   native timeline/keyboard seeks. Drift is still only corrected once a
   second — always after the seek check, so a fresh user seek is shared
   instead of being yanked back to the old shared position. */
const SAMPLE_MS = 250;
const DRIFT_EVERY = 4;
/* A jump bigger than this between two samples (beyond what playback could
   explain) is a seek. */
const SEEK_JUMP_S = 1;
/* Programmatic player calls fire onStateChange too — ignore events for this
   long after we act, or every client would echo every command back. */
const SUPPRESS_MS = 1200;
/* Our own seek can land late (the iframe reports time asynchronously); a
   jump onto a recent target of ours is never a user seek. */
const OWN_SEEK_MS = 5000;
/* After sharing a local pause/play/seek, don't drift-correct until the
   server's echo has had time to arrive — otherwise we'd undo the user. */
const AWAIT_ECHO_MS = 2000;
/* If we should be playing but aren't for this long, the browser probably
   blocked autoplay — ask for a click. */
const GESTURE_TIMEOUT_MS = 3000;
const VOLUME_KEY = 'yt_volume';
const MUTED_KEY = 'yt_muted';
/* getVolume()/isMuted() are cached from iframe messages and lag behind our
   restore on ready; don't persist until they've caught up. */
const VOLUME_SETTLE_MS = 2000;
const RATE_NOTICE = 'Playback speed is fixed at 1× so everyone stays in sync';

/** States in which getCurrentTime() is the real timeline of the shared video. */
const TRACKED_STATES: number[] = [PlayerState.PLAYING, PlayerState.PAUSED, PlayerState.BUFFERING];

interface Sample {
  time: number;
  at: number;
  state: number;
  videoId: string | undefined;
  duration: number;
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

function savedVolume(): number {
  const v = Number(localStorage.getItem(VOLUME_KEY) ?? 100);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
}

export default function YouTubeTab({ shared, clockOffset, connected, onNotify }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const sharedRef = useRef<YouTubeState | null>(shared);
  const offsetRef = useRef(clockOffset);
  const notifyRef = useRef(onNotify);
  const suppressUntil = useRef(0);
  const awaitEchoUntil = useRef(0);
  const lastState = useRef<number>(PlayerState.UNSTARTED);
  const notPlayingSince = useRef<number | null>(null);
  /** videoId whose duration we've already reported to the server */
  const reportedDuration = useRef<string | null>(null);
  /* Seek detection */
  const sample = useRef<Sample | null>(null);
  const ownSeek = useRef<{ target: number; at: number } | null>(null);
  /** Video that has reached PLAYING/PAUSED since it was loaded — before that its clock jumps freely. */
  const settledVideo = useRef<string | null>(null);
  /** Last rate we set ourselves, so our drift nudges aren't mistaken for the user's. */
  const lastRate = useRef(1);
  /* Per-person volume */
  const lastVolume = useRef<{ volume: number; muted: boolean } | null>(null);
  const volumeSettleUntil = useRef(0);

  const [input, setInput] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  sharedRef.current = shared;
  offsetRef.current = clockOffset;
  notifyRef.current = onNotify;

  /** Where the shared timeline is right now, in seconds. */
  const expectedPosition = useCallback((): number => {
    const s = sharedRef.current;
    if (!s) return 0;
    if (!s.playing) return s.position;
    const serverNow = Date.now() + offsetRef.current;
    return s.position + Math.max(0, serverNow - s.updatedAt) / 1000;
  }, []);

  const suppress = () => { suppressUntil.current = Date.now() + SUPPRESS_MS; };

  /** Every programmatic seek goes through here so the seek detector knows it was us. */
  const seekPlayer = (player: YTPlayer, target: number) => {
    suppress();
    ownSeek.current = { target, at: Date.now() };
    player.seekTo(target, true);
  };

  const setRate = (player: YTPlayer, rate: number) => {
    if (player.getPlaybackRate() === rate) return;
    // Rate changes fire no state events, only onPlaybackRateChange — which
    // lastRate covers. A suppress() window here would blind pause/seek
    // sharing for 1.2 s after every nudge.
    lastRate.current = rate;
    player.setPlaybackRate(rate);
  };

  /** Shares a change the user made with the native controls. */
  const share = (command: ws.YouTubeCommand) => {
    awaitEchoUntil.current = Date.now() + AWAIT_ECHO_MS;
    if (!ws.sendYoutube(command)) notifyRef.current('Not connected to the bot — can’t sync');
  };

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
      ownSeek.current = { target, at: Date.now() };
      if (s.playing) player.loadVideoById({ videoId: s.videoId, startSeconds: target });
      else player.cueVideoById({ videoId: s.videoId, startSeconds: target });
      return;
    }

    const st = player.getPlayerState();
    const localPlaying = st === PlayerState.PLAYING || st === PlayerState.BUFFERING;
    if (Math.abs(player.getCurrentTime() - target) > (s.playing ? HARD_SEEK_S : 0.5)) {
      seekPlayer(player, target);
    }
    if (s.playing && !localPlaying) {
      suppress();
      player.playVideo();
    } else if (!s.playing && localPlaying) {
      suppress();
      player.pauseVideo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            // YouTube's own controls and shortcuts: play/pause and seeks are
            // detected and shared; quality, captions, volume and fullscreen
            // are per person.
            controls: 1,
            fs: 1,
            disablekb: 0,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              readyRef.current = true;
              restoreVolume(e.target);
              apply();
            },
            onStateChange: (e) => onStateChange(e.data, e.target),
            onPlaybackRateChange: (e) => onPlaybackRateChange(e.data, e.target),
            onError: (e) => notifyRef.current(describePlayerError(e.data)),
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

  function restoreVolume(player: YTPlayer) {
    const volume = savedVolume();
    const muted = localStorage.getItem(MUTED_KEY) === '1';
    player.setVolume(volume);
    if (muted) player.mute();
    lastVolume.current = { volume, muted };
    volumeSettleUntil.current = Date.now() + VOLUME_SETTLE_MS;
  }

  /** Volume is per person: remember whatever they set in YouTube's own controls. */
  function persistVolume(player: YTPlayer) {
    if (Date.now() < volumeSettleUntil.current || !lastVolume.current) return;
    const volume = player.getVolume();
    const muted = player.isMuted();
    if (typeof volume === 'number' && volume !== lastVolume.current.volume) {
      localStorage.setItem(VOLUME_KEY, String(volume));
      lastVolume.current.volume = volume;
    }
    if (typeof muted === 'boolean' && muted !== lastVolume.current.muted) {
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
      lastVolume.current.muted = muted;
    }
  }

  /* Drift correction steers the playback rate, so a user-chosen speed would
     both desync them and fight the nudges — pin it to 1×. */
  function onPlaybackRateChange(rate: number, player: YTPlayer) {
    if (rate === 1 || rate === lastRate.current) return;
    lastRate.current = 1;
    suppress();
    player.setPlaybackRate(1);
    notifyRef.current(RATE_NOTICE);
  }

  /** Turns native play/pause (click, tap, keyboard) into shared commands. */
  function onStateChange(next: number, player: YTPlayer) {
    const prev = lastState.current;
    // Resuming goes PAUSED → BUFFERING → PLAYING; remembering BUFFERING as
    // "prev" hid the resume and it was never shared.
    if (next !== PlayerState.BUFFERING) lastState.current = next;

    if (next === PlayerState.PLAYING) setNeedsGesture(false);
    if (next === PlayerState.PLAYING || next === PlayerState.CUED) setTitle(player.getVideoData().title || null);

    // Report the end even during suppression — the server keeps only the
    // first report for the current video and advances the queue.
    const current = sharedRef.current;
    if (next === PlayerState.ENDED && current?.videoId && player.getVideoData().video_id === current.videoId) {
      ws.sendYoutube({ type: 'yt:ended', videoId: current.videoId });
    }

    if (Date.now() < suppressUntil.current) return;
    const s = sharedRef.current;
    // A suggested video clicked inside the embed isn't the shared one.
    if (!s?.videoId || player.getVideoData().video_id !== s.videoId) return;

    // Mobile browsers pause media when backgrounded — don't pause everyone.
    if (next === PlayerState.PAUSED && prev === PlayerState.PLAYING && s.playing && !document.hidden) {
      share({ type: 'yt:pause', position: player.getCurrentTime() });
    } else if (
      next === PlayerState.PLAYING &&
      !s.playing &&
      (prev === PlayerState.PAUSED || prev === PlayerState.CUED || prev === PlayerState.ENDED)
    ) {
      share({ type: 'yt:play', position: player.getCurrentTime() });
    }
  }

  /**
   * Samples the player and returns the new position if it jumped in a way
   * playback can't explain — i.e. the user seeked with YouTube's timeline or
   * keyboard. Always re-baselines, so every comparison is between two
   * consecutive samples.
   */
  function detectUserSeek(player: YTPlayer, s: YouTubeState | null): number | null {
    const now = Date.now();
    const prev = sample.current;
    const next: Sample = {
      time: player.getCurrentTime() || 0,
      at: now,
      state: player.getPlayerState(),
      videoId: player.getVideoData().video_id,
      duration: player.getDuration() || 0,
    };
    sample.current = next;
    // Judge against what was settled *before* this sample: a fresh load
    // jumps to its start position on its way to PLAYING.
    const settled = !!next.videoId && settledVideo.current === next.videoId;
    if (next.state === PlayerState.PLAYING || next.state === PlayerState.PAUSED) {
      settledVideo.current = next.videoId ?? null;
    }

    if (
      !prev || !settled || document.hidden || now < suppressUntil.current ||
      !s?.videoId || next.videoId !== s.videoId || prev.videoId !== next.videoId ||
      // An ad reports its own duration and clock — never a user seek.
      prev.duration !== next.duration ||
      !TRACKED_STATES.includes(prev.state) || !TRACKED_STATES.includes(next.state)
    ) return null;

    // While playing (or buffering, which may resume mid-interval) time may
    // advance by anything from 0 (stall) to elapsed × rate; paused, not at all.
    const moving = [prev.state, next.state].some((st) => st === PlayerState.PLAYING || st === PlayerState.BUFFERING);
    const elapsed = (now - prev.at) / 1000;
    const maxAdvance = moving ? elapsed * Math.max(1, player.getPlaybackRate() || 1) : 0;
    if (next.time >= prev.time - SEEK_JUMP_S && next.time <= prev.time + maxAdvance + SEEK_JUMP_S) return null;

    const own = ownSeek.current;
    if (own && now - own.at < OWN_SEEK_MS) {
      const ran = moving ? ((now - own.at) / 1000) * 1.05 : 0;
      if (next.time >= own.target - SEEK_JUMP_S && next.time <= own.target + ran + SEEK_JUMP_S) return null;
    }
    return next.time;
  }

  /* Re-sync whenever the shared state (or clock estimate) changes. */
  useEffect(() => {
    if (!shared?.videoId) {
      setTitle(null);
      setNeedsGesture(false);
    }
    // Every (re)start resets the server's duration — report it again, even
    // when the same video is played twice in a row.
    if (!shared?.duration && (shared?.action === 'load' || shared?.action === 'advance' || shared?.action === 'skip')) {
      reportedDuration.current = null;
    }
    apply();
  }, [shared, clockOffset, apply]);

  /* ─── seek detection, volume, reports, drift correction ─── */
  useEffect(() => {
    let samples = 0;
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      const s = sharedRef.current;
      if (!player || !readyRef.current) return;

      persistVolume(player);
      const driftTick = ++samples % DRIFT_EVERY === 0;

      // Must run before drift correction: drift would otherwise hard-seek
      // the user back to the old shared position before their seek is shared.
      const seekedTo = detectUserSeek(player, s);
      if (seekedTo !== null) {
        share({ type: 'yt:seek', position: seekedTo });
        return;
      }

      if (!driftTick) return;

      const d = player.getDuration();
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

      const now = Date.now();
      if (!s?.videoId || now < suppressUntil.current || now < awaitEchoUntil.current) return;
      const st = player.getPlayerState();

      // Someone clicked a suggested video in the embed — bring them back.
      const showing = player.getVideoData().video_id;
      if (showing && showing !== s.videoId) {
        apply();
        return;
      }

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
        notPlayingSince.current ??= now;
        if (now - notPlayingSince.current > GESTURE_TIMEOUT_MS) setNeedsGesture(true);
        else apply();
        return;
      }
      notPlayingSince.current = null;

      const target = expectedPosition();
      if (d && target >= d) return; // shared timeline ran past the end
      const drift = player.getCurrentTime() - target;
      if (Math.abs(drift) > HARD_SEEK_S) {
        seekPlayer(player, target);
      } else if (Math.abs(drift) > NUDGE_S) {
        setRate(player, drift > 0 ? 0.95 : 1.05);
      } else {
        setRate(player, 1);
      }
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const join = () => {
    setNeedsGesture(false);
    notPlayingSince.current = null;
    suppress();
    playerRef.current?.playVideo();
    apply();
  };

  const hasVideo = !!shared?.videoId;
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

      <div className="yt-frame">
        <div ref={containerRef} className="yt-player" />
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
          <div className="yt-buttons">
            <button
              className="np-btn"
              disabled={!connected || queue.length === 0}
              onClick={() => send({ type: 'yt:skip' })}
              aria-label="Next video"
              title={queue.length ? 'Skip to the next queued video' : 'Nothing queued'}
            >
              ⏭
            </button>
            <button className="btn" onClick={apply} title="Snap to the shared position">Resync</button>
            <button className="btn subtle" disabled={!connected} onClick={() => send({ type: 'yt:clear' })}>
              Stop for everyone
            </button>
          </div>
        </div>
      )}

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
