import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as ws from '../src/ws';
import YouTubeTab from '../src/components/YouTubeTab';
import { PlayerState } from '../src/youtube';
import type { YouTubeState } from '../src/types';

vi.mock('../src/ws', () => ({ sendYoutube: vi.fn(() => true) }));
const sendYoutube = vi.mocked(ws.sendYoutube);

const V = 'dQw4w9WgXcQ';
const V2 = 'aaaaaaaaaaa';
const RATE_NOTICE = 'Playback speed is fixed at 1× so everyone stays in sync';

type Events = {
  onReady: (e: unknown) => void;
  onStateChange: (e: unknown) => void;
  onPlaybackRateChange: (e: unknown) => void;
  onError: (e: unknown) => void;
};

/** Stand-in for YT.Player: records calls, lets the test drive state. */
class FakePlayer {
  static last: FakePlayer;
  opts: { videoId?: string; playerVars: Record<string, unknown>; events: Events };
  state: number = PlayerState.UNSTARTED;
  videoId: string | undefined;
  duration = 200;
  rate = 1;
  volume = 100;
  muted = false;
  time = 0;
  /** When set, getCurrentTime() is computed (e.g. a playing clock). */
  timeFn: (() => number) | null = null;
  /** When true, seekTo() is recorded but only lands on land() — like a slow iframe. */
  lagSeeks = false;
  pendingSeek: { t: number; at: number } | null = null;
  calls: unknown[] = [];

  constructor(_el: HTMLElement, opts: FakePlayer['opts']) {
    this.opts = opts;
    this.videoId = opts.videoId;
    FakePlayer.last = this;
  }

  get events() { return this.opts.events; }

  playVideo() { this.calls.push('play'); }
  pauseVideo() { this.calls.push('pause'); }
  seekTo(t: number) {
    this.calls.push(['seek', Math.round(t * 10) / 10]);
    if (this.lagSeeks) this.pendingSeek = { t, at: Date.now() };
    else this.jumpTo(t);
  }
  loadVideoById(o: { videoId: string; startSeconds?: number }) {
    this.calls.push(['load', o.videoId]);
    this.videoId = o.videoId;
    this.state = PlayerState.UNSTARTED;
    this.jumpTo(o.startSeconds ?? 0);
  }
  cueVideoById(o: { videoId: string; startSeconds?: number }) {
    this.calls.push(['cue', o.videoId]);
    this.videoId = o.videoId;
    this.state = PlayerState.CUED;
    this.jumpTo(o.startSeconds ?? 0);
  }
  getCurrentTime() { return this.timeFn ? this.timeFn() : this.time; }
  getDuration() { return this.duration; }
  getPlayerState() { return this.state; }
  getVideoData() { return { video_id: this.videoId, title: 'Player title' }; }
  setVolume(v: number) { this.calls.push(['volume', v]); this.volume = v; }
  getVolume() { return this.volume; }
  isMuted() { return this.muted; }
  mute() { this.calls.push('mute'); this.muted = true; }
  unMute() { this.calls.push('unMute'); this.muted = false; }
  setPlaybackRate(r: number) {
    this.calls.push(['rate', r]);
    this.rate = r;
    // The real player reports programmatic rate changes too.
    this.events.onPlaybackRateChange({ data: r, target: this });
  }
  getPlaybackRate() { return this.rate; }
  destroy() {}

  ready() { this.events.onReady({ target: this }); }
  fire(state: number) {
    this.state = state;
    this.events.onStateChange({ data: state, target: this });
  }
  /** Moves the clock to t; it keeps running if the player is playing. */
  jumpTo(t: number) {
    if (this.state === PlayerState.PLAYING) {
      const at = Date.now();
      this.timeFn = () => t + (Date.now() - at) / 1000;
    } else {
      this.timeFn = null;
      this.time = t;
    }
  }
  /** The late seek finally lands, where it would be by now. */
  land() {
    const s = this.pendingSeek!;
    this.pendingSeek = null;
    this.jumpTo(s.t + (Date.now() - s.at) / 1000);
  }
  /** The user drags YouTube's timeline (or presses an arrow key). */
  userSeek(t: number) { this.jumpTo(t); }
  /** The user picks a speed in YouTube's settings menu. */
  userRate(r: number) {
    this.rate = r;
    this.events.onPlaybackRateChange({ data: r, target: this });
  }
  freeze() {
    this.time = this.getCurrentTime();
    this.timeFn = null;
  }
}

const notify = vi.fn();

const shared = (over: Partial<YouTubeState> = {}): YouTubeState => ({
  videoId: V, title: 'Shared title', duration: null, playing: true, position: 0, updatedAt: Date.now(),
  by: { userId: 'bob', username: 'Bob' }, action: 'load', queue: [], ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  window.YT = { Player: FakePlayer } as never;
  sendYoutube.mockClear();
  sendYoutube.mockReturnValue(true);
  notify.mockClear();
});

afterEach(() => {
  delete window.YT;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mount(state: YouTubeState | null, { connected = true } = {}) {
  const view = render(<YouTubeTab shared={state} clockOffset={0} connected={connected} onNotify={notify} />);
  await act(async () => {}); // loadYouTubeApi() resolves → player constructed
  const p = FakePlayer.last;
  act(() => p.ready());
  const update = (next: YouTubeState | null) =>
    view.rerender(<YouTubeTab shared={next} clockOffset={0} connected={connected} onNotify={notify} />);
  return { p, update, ...view };
}

const sent = (type: string) => sendYoutube.mock.calls.map((c) => c[0]).filter((m) => m.type === type);
const syncSent = () => sendYoutube.mock.calls.map((c) => c[0]).filter((m) => ['yt:play', 'yt:pause', 'yt:seek'].includes(m.type));
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const seeks = (calls: unknown[]) => calls.filter((c) => Array.isArray(c) && c[0] === 'seek');

/**
 * A playing, in-sync player, 2 s in (just after a once-a-second drift
 * check), past the suppression window. drift(d) ramps the offset to d over
 * one second, like real drift — an instant jump would be a seek.
 */
async function inSync() {
  const start = Date.now();
  const m = await mount(shared({ updatedAt: start }));
  m.p.state = PlayerState.PLAYING;
  const expected = () => (Date.now() - start) / 1000;
  m.p.timeFn = expected;
  tick(2000);
  m.p.calls.length = 0;
  sendYoutube.mockClear();
  let offset = 0;
  const drift = (d: number) => {
    const from = offset;
    const t0 = Date.now();
    offset = d;
    m.p.timeFn = () => expected() + from + (d - from) * Math.min(1, (Date.now() - t0) / 1000);
  };
  /** The server echoes a command back as the new anchor. */
  const echo = (over: Partial<YouTubeState>) => m.update(shared({ updatedAt: Date.now(), ...over }));
  return { ...m, drift, echo, expected };
}

describe('native YouTube controls', () => {
  test('the embed uses YouTube’s controls, keyboard and fullscreen', async () => {
    const { p } = await mount(shared());
    expect(p.opts.playerVars).toMatchObject({
      controls: 1, fs: 1, disablekb: 0, rel: 0, playsinline: 1, iv_load_policy: 3, origin: window.location.origin,
    });
  });

  test('nothing covers the iframe while a video is on', async () => {
    await mount(shared());
    const frame = document.querySelector('.yt-frame')!;
    expect(frame.children).toHaveLength(1);
    expect(frame.firstElementChild).toHaveClass('yt-player');
  });

  test('our bar keeps only skip, Resync and Stop — no seek, play or volume', async () => {
    const queue = [{ id: 4, videoId: V2, title: 'Second video', addedBy: null, addedAt: 0 }];
    await mount(shared({ queue }));
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^(Play|Pause|Seek|Back 10 seconds|Forward 10 seconds|Fullscreen)$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/volume/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Next video')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resync' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop for everyone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Up next (1)' })).toBeInTheDocument();
  });
});

describe('applying shared state', () => {
  test('on ready, a playing shared video starts locally', async () => {
    const { p } = await mount(shared());
    expect(p.videoId).toBe(V);
    expect(p.calls).toContain('play');
  });

  test('a different shared video is loaded (playing) or cued (paused)', async () => {
    const { p, update } = await mount(shared());
    update(shared({ videoId: V2 }));
    expect(p.calls).toContainEqual(['load', V2]);
    update(shared({ videoId: V, playing: false }));
    expect(p.calls).toContainEqual(['cue', V]);
  });

  test('a cleared video pauses the local player', async () => {
    const { p, update } = await mount(shared());
    p.state = PlayerState.PLAYING;
    update(shared({ videoId: null, playing: false }));
    expect(p.calls.at(-1)).toBe('pause');
  });

  test('a suggested video clicked inside the embed is not shared, and the shared one comes back', async () => {
    const { p } = await inSync();
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    p.calls.length = 0;
    p.videoId = 'zzzzzzzzzzz';
    act(() => p.fire(PlayerState.PAUSED));
    act(() => p.fire(PlayerState.PLAYING));
    p.userSeek(0);
    tick(1000);
    expect(syncSent()).toEqual([]);
    expect(p.calls).toContainEqual(['load', V]);
  });
});

describe('native play/pause', () => {
  test('pause then resume (PAUSED → BUFFERING → PLAYING) is shared once each', async () => {
    const { p, echo } = await inSync();
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    p.freeze();
    act(() => p.fire(PlayerState.PAUSED));
    const at = p.getCurrentTime();
    expect(sent('yt:pause')).toEqual([{ type: 'yt:pause', position: at }]);

    tick(1000); // echo not here yet: drift correction must not resume us
    expect(p.calls).not.toContain('play');
    echo({ playing: false, position: at, action: 'pause' });

    tick(1500);
    act(() => p.fire(PlayerState.BUFFERING));
    act(() => p.fire(PlayerState.PLAYING));
    expect(sent('yt:play')).toEqual([{ type: 'yt:play', position: at }]);
    echo({ playing: true, position: at, action: 'play' });
    p.jumpTo(at);
    tick(3000);
    expect(sent('yt:pause')).toHaveLength(1);
    expect(sent('yt:play')).toHaveLength(1);
    expect(sent('yt:seek')).toEqual([]);
  });

  test('a background-tab pause (mobile) is not shared', async () => {
    const { p } = await mount(shared());
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => p.fire(PlayerState.PAUSED));
    expect(sent('yt:pause')).toEqual([]);
  });

  test('replaying from the end screen is shared', async () => {
    const { p, update } = await mount(shared());
    act(() => p.fire(PlayerState.ENDED));
    update(shared({ playing: false, position: 200, action: 'ended' }));
    tick(1500);
    p.time = 0;
    act(() => p.fire(PlayerState.PLAYING));
    expect(sent('yt:play')).toEqual([{ type: 'yt:play', position: 0 }]);
  });
});

describe('native seeks', () => {
  test('a seek while playing is shared once, before drift correction can undo it', async () => {
    const { p, echo } = await inSync();
    tick(750); // the next sample is also a drift check
    p.userSeek(100);
    tick(250);
    expect(sent('yt:seek')).toEqual([{ type: 'yt:seek', position: 100.25 }]); // where it is now, not where it landed
    expect(seeks(p.calls)).toEqual([]);

    tick(250); // still waiting for the echo
    echo({ position: p.getCurrentTime(), action: 'seek' });
    tick(5000);
    expect(sent('yt:seek')).toHaveLength(1);
    expect(seeks(p.calls)).toEqual([]);
  });

  test('a backwards seek (e.g. ← key) is shared too', async () => {
    const { p } = await inSync();
    tick(3000);
    p.userSeek(0);
    tick(250);
    expect(sent('yt:seek')).toEqual([{ type: 'yt:seek', position: 0.25 }]);
  });

  test('a seek while paused is shared, and a later resume still is', async () => {
    const { p, update } = await mount(shared({ playing: false, position: 5, action: 'pause' }));
    act(() => p.fire(PlayerState.PAUSED));
    tick(1500);
    act(() => p.fire(PlayerState.BUFFERING));
    p.userSeek(60);
    act(() => p.fire(PlayerState.PAUSED));
    tick(250);
    expect(sent('yt:seek')).toEqual([{ type: 'yt:seek', position: 60 }]);
    update(shared({ playing: false, position: 60, action: 'seek', updatedAt: Date.now() }));
    expect(seeks(p.calls)).toEqual([['seek', 5]]); // only the initial apply()

    tick(1500);
    act(() => p.fire(PlayerState.BUFFERING));
    act(() => p.fire(PlayerState.PLAYING));
    expect(sent('yt:play')).toEqual([{ type: 'yt:play', position: 60 }]);
    expect(sent('yt:pause')).toEqual([]);
  });

  test('seeks made by apply() (a remote seek) are not sent', async () => {
    const { p, echo } = await inSync();
    echo({ position: 80, action: 'seek' });
    expect(seeks(p.calls)).toEqual([['seek', 80]]);
    tick(5000);
    expect(syncSent()).toEqual([]);
  });

  test('drift-correction hard seeks are not sent', async () => {
    const { p } = await inSync();
    p.freeze(); // decoder stall while "playing"
    tick(2000);
    expect(p.calls).toEqual([['rate', 1.05], ['seek', 4]]);
    tick(5000);
    expect(syncSent()).toEqual([]);
  });

  test('our own seek landing after the suppression window is not mistaken for the user', async () => {
    const { p } = await inSync();
    p.lagSeeks = true;
    p.freeze();
    tick(2000);
    expect(seeks(p.calls)).toEqual([['seek', 4]]);
    tick(1250); // well past the 1.2 s window
    p.land();
    tick(250);
    expect(syncSent()).toEqual([]);
  });

  test('a buffering stall (time standing still) is not a seek', async () => {
    const { p } = await inSync();
    p.freeze();
    p.state = PlayerState.BUFFERING;
    tick(4000);
    p.state = PlayerState.PLAYING;
    tick(3000);
    expect(seeks(p.calls).length).toBeGreaterThan(0); // drift caught us up
    expect(syncSent()).toEqual([]);
  });

  test('a freshly loaded or cued video jumping to its start is not a seek', async () => {
    const { p, echo } = await inSync();
    echo({ videoId: V2, position: 0, action: 'load' });
    expect(p.calls).toContainEqual(['load', V2]);
    tick(1500);
    p.state = PlayerState.BUFFERING;
    tick(500);
    p.time = 30; // e.g. YouTube resuming where this viewer left off
    tick(500);
    p.state = PlayerState.PLAYING;
    tick(500);

    echo({ videoId: V, playing: false, position: 42, action: 'load' });
    expect(p.calls).toContainEqual(['cue', V]);
    tick(1500);
    p.time = 0;
    tick(1000);
    expect(syncSent()).toEqual([]);
  });

  test('an ad (its own duration and clock) is not a seek', async () => {
    const { p } = await inSync();
    p.duration = 15;
    p.userSeek(0);
    tick(1000);
    p.duration = 200;
    p.userSeek(5);
    tick(250);
    expect(sent('yt:seek')).toEqual([]);
  });
});

describe('echo suppression', () => {
  test('events caused by our own player calls are not sent back', async () => {
    const { p, update } = await mount(shared());
    act(() => p.fire(PlayerState.PLAYING));
    update(shared({ playing: false, position: 42, action: 'pause' }));
    expect(p.calls).toContainEqual(['seek', 42]);
    expect(p.calls.at(-1)).toBe('pause');
    act(() => p.fire(PlayerState.PAUSED));
    expect(sendYoutube).not.toHaveBeenCalled();
  });

  test('remote pause, play and seek never bounce back', async () => {
    const { p, echo } = await inSync();
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    sendYoutube.mockClear();

    echo({ playing: false, position: p.getCurrentTime(), action: 'pause' });
    p.freeze();
    act(() => p.fire(PlayerState.PAUSED));
    tick(1000);
    echo({ playing: true, position: p.getCurrentTime(), action: 'play' });
    act(() => p.fire(PlayerState.BUFFERING));
    act(() => p.fire(PlayerState.PLAYING));
    p.jumpTo(p.getCurrentTime());
    tick(1000);
    echo({ position: 120, action: 'seek' });
    act(() => p.fire(PlayerState.BUFFERING));
    act(() => p.fire(PlayerState.PLAYING));
    tick(5000);

    expect(p.calls).toEqual(expect.arrayContaining(['pause', 'play', ['seek', 120]]));
    expect(syncSent()).toEqual([]);
  });
});

describe('playback speed', () => {
  test('a speed picked by the user is reset to 1× with a notice', async () => {
    const { p } = await inSync();
    act(() => p.userRate(2));
    expect(p.calls).toEqual([['rate', 1]]);
    expect(p.rate).toBe(1);
    expect(notify).toHaveBeenCalledWith(RATE_NOTICE);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('our own 0.95/1.05 nudges never trigger the notice', async () => {
    const { p, drift } = await inSync();
    drift(1.4);
    tick(1000);
    drift(-0.6);
    tick(1000);
    drift(0);
    tick(1000);
    expect(p.calls).toEqual([['rate', 0.95], ['rate', 1.05], ['rate', 1]]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('per-person volume', () => {
  test('saved volume and mute are restored on ready', async () => {
    localStorage.setItem('yt_volume', '30');
    localStorage.setItem('yt_muted', '1');
    const { p } = await mount(shared());
    expect(p.volume).toBe(30);
    expect(p.muted).toBe(true);
  });

  test('defaults to full volume, unmuted', async () => {
    const { p } = await mount(shared());
    expect(p.calls).toContainEqual(['volume', 100]);
    expect(p.calls).not.toContain('mute');
  });

  test('changes made in YouTube’s controls are saved, and only on change', async () => {
    localStorage.setItem('yt_volume', '30');
    const { p } = await mount(shared());
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    tick(3000);
    expect(setItem).not.toHaveBeenCalled();
    p.volume = 55;
    tick(250);
    expect(localStorage.getItem('yt_volume')).toBe('55');
    p.muted = true;
    tick(1000);
    expect(localStorage.getItem('yt_muted')).toBe('1');
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});

describe('reports to the server', () => {
  test('"ended" is sent once per end, even inside the suppression window', async () => {
    const { p } = await mount(shared());
    act(() => p.fire(PlayerState.ENDED));
    tick(5000);
    expect(sent('yt:ended')).toEqual([{ type: 'yt:ended', videoId: V }]);
  });

  test('"ended" for a video that is no longer the shared one is not sent', async () => {
    const { p, update } = await mount(shared());
    update(shared({ videoId: V2 }));
    p.videoId = V; // player still showing the old one
    act(() => p.fire(PlayerState.ENDED));
    expect(sent('yt:ended')).toEqual([]);
  });

  test('duration is reported once per video, and not when already known', async () => {
    const { update } = await mount(shared());
    tick(5000);
    expect(sent('yt:meta')).toEqual([{ type: 'yt:meta', videoId: V, duration: 200 }]);
    update(shared({ videoId: V2, action: 'advance' }));
    tick(3000);
    expect(sent('yt:meta')).toHaveLength(2);
    update(shared({ videoId: V, duration: 200, action: 'advance' }));
    tick(3000);
    expect(sent('yt:meta')).toHaveLength(2);
  });

  test('the same video loaded again reports its duration again', async () => {
    const { update } = await mount(shared());
    tick(2000);
    update(shared({ action: 'load', updatedAt: Date.now() })); // server reset duration to null
    tick(2000);
    expect(sent('yt:meta')).toHaveLength(2);
  });
});

describe('drift correction', () => {
  test('> 1.5 s off: hard seek to the shared position', async () => {
    const { p } = await inSync();
    p.freeze(); // stalls at 2 s while the shared clock runs on
    tick(1000);
    expect(p.calls).toEqual([['rate', 1.05]]); // 1 s behind: nudge
    tick(1000);
    expect(p.calls).toEqual([['rate', 1.05], ['seek', 4]]);
  });

  test('0.3–1.5 s ahead/behind: nudge the playback rate, no seek', async () => {
    const { p, drift } = await inSync();
    drift(1.4);
    tick(1000);
    expect(p.calls).toEqual([['rate', 0.95]]);
    drift(-0.6);
    tick(1000);
    expect(p.calls).toEqual([['rate', 0.95], ['rate', 1.05]]);
  });

  test('≤ 0.3 s: back to normal speed', async () => {
    const { p, drift } = await inSync();
    drift(0.8);
    tick(1000);
    drift(0.1);
    tick(1000);
    expect(p.calls).toEqual([['rate', 0.95], ['rate', 1]]);
  });

  test('no correction once the shared timeline is past the end', async () => {
    const { p } = await inSync();
    p.duration = 1;
    p.freeze();
    tick(3000);
    expect(p.calls).toEqual([]);
  });

  test('a seek nobody echoes (socket down) is reported, then undone', async () => {
    const { p } = await inSync();
    sendYoutube.mockReturnValue(false);
    p.userSeek(100);
    tick(250);
    expect(notify).toHaveBeenCalledWith('Not connected to the bot — can’t sync');
    tick(3000);
    expect(seeks(p.calls)).toHaveLength(1);
  });
});

describe('blocked autoplay', () => {
  test('asks for a click when the player will not start, and the click starts it', async () => {
    const { p } = await mount(shared());
    p.state = PlayerState.CUED; // the browser refused to autoplay
    tick(6000);
    const join = screen.getByRole('button', { name: /join the watch party/ });
    expect(join.closest('.yt-frame')).not.toBeNull(); // sits over the video
    p.calls.length = 0;
    fireEvent.click(join);
    expect(p.calls[0]).toBe('play');
    expect(screen.queryByRole('button', { name: /join the watch party/ })).not.toBeInTheDocument();
  });

  test('buffering is not mistaken for blocked autoplay', async () => {
    const { p } = await mount(shared());
    p.state = PlayerState.BUFFERING;
    tick(10_000);
    expect(screen.queryByRole('button', { name: /join the watch party/ })).not.toBeInTheDocument();
  });
});

describe('queue and controls UI', () => {
  const queue = [
    { id: 4, videoId: V2, title: 'Second video', addedBy: { userId: 'bob', username: 'Bob' }, addedAt: 0 },
    { id: 5, videoId: 'bbbbbbbbbbb', title: null, addedBy: null, addedAt: 0 },
  ];

  test('lists the queue; remove and skip send commands', async () => {
    await mount(shared({ queue }));
    expect(screen.getByRole('heading', { name: 'Up next (2)' })).toBeInTheDocument();
    expect(screen.getByText('added by Bob')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbbbbbb')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove Second video'));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:dequeue', id: 4 });
    fireEvent.click(screen.getByLabelText('Next video'));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:skip' });
  });

  test('skip is disabled with an empty queue; everything is disabled offline', async () => {
    await mount(shared(), { connected: false });
    expect(screen.getByLabelText('Next video')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop for everyone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Queue' })).toBeDisabled();
  });

  test('"Stop for everyone" clears; Resync snaps to the shared position', async () => {
    const { p } = await inSync();
    fireEvent.click(screen.getByRole('button', { name: 'Stop for everyone' }));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:clear' });
    p.userSeek(50);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    expect(seeks(p.calls)).toEqual([['seek', 2]]);
  });

  test('pasting a link queues it; "Play now" loads it; junk is refused', async () => {
    await mount(shared());
    const input = screen.getByPlaceholderText(/queue it/);
    fireEvent.change(input, { target: { value: 'not a link' } });
    fireEvent.submit(input.closest('form')!);
    expect(notify).toHaveBeenCalledWith('That doesn’t look like a YouTube link');
    expect(sendYoutube).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: `https://youtu.be/${V2}` } });
    fireEvent.submit(input.closest('form')!);
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:enqueue', videoId: V2 });
    expect(notify).toHaveBeenLastCalledWith('Added to the queue');
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: V2 } });
    fireEvent.click(screen.getByRole('button', { name: 'Play now' }));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:load', videoId: V2 });
  });

  test('a dropped socket is reported instead of silently ignored', async () => {
    sendYoutube.mockReturnValue(false);
    await mount(shared());
    fireEvent.click(screen.getByRole('button', { name: 'Stop for everyone' }));
    expect(notify).toHaveBeenCalledWith('Not connected to the bot — can’t sync');
  });

  test('nothing on: placeholder, no controls', async () => {
    await mount(null);
    expect(screen.getByText(/Nothing on yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Next video')).not.toBeInTheDocument();
  });
});
