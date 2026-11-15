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

/** Stand-in for YT.Player: records calls, lets the test drive state. */
class FakePlayer {
  static last: FakePlayer;
  state: number = PlayerState.UNSTARTED;
  videoId: string | undefined;
  duration = 200;
  rate = 1;
  time = 0;
  /** When set, getCurrentTime() is computed (e.g. expected position + drift). */
  timeFn: (() => number) | null = null;
  calls: unknown[] = [];
  events: { onReady: (e: unknown) => void; onStateChange: (e: unknown) => void; onError: (e: unknown) => void };

  constructor(_el: HTMLElement, opts: { videoId?: string; events: FakePlayer['events'] }) {
    this.videoId = opts.videoId;
    this.events = opts.events;
    FakePlayer.last = this;
  }

  playVideo() { this.calls.push('play'); }
  pauseVideo() { this.calls.push('pause'); }
  seekTo(t: number) { this.calls.push(['seek', Math.round(t * 10) / 10]); this.time = t; this.timeFn = null; }
  loadVideoById(o: { videoId: string; startSeconds?: number }) { this.calls.push(['load', o.videoId]); this.videoId = o.videoId; }
  cueVideoById(o: { videoId: string; startSeconds?: number }) { this.calls.push(['cue', o.videoId]); this.videoId = o.videoId; }
  getCurrentTime() { return this.timeFn ? this.timeFn() : this.time; }
  getDuration() { return this.duration; }
  getPlayerState() { return this.state; }
  getVideoData() { return { video_id: this.videoId, title: 'Player title' }; }
  setVolume() {}
  getVolume() { return 100; }
  setPlaybackRate(r: number) { this.calls.push(['rate', r]); this.rate = r; }
  getPlaybackRate() { return this.rate; }
  destroy() {}

  ready() { this.events.onReady({ target: this }); }
  fire(state: number) {
    this.state = state;
    this.events.onStateChange({ data: state, target: this });
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
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

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

  test('a real click on the video (outside the window) is shared', async () => {
    const { p, update } = await mount(shared());
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    p.time = 12.3;
    act(() => p.fire(PlayerState.PAUSED));
    expect(sent('yt:pause')).toEqual([{ type: 'yt:pause', position: 12.3 }]);

    update(shared({ playing: false, position: 12.3, action: 'pause' }));
    tick(1500);
    act(() => p.fire(PlayerState.PLAYING));
    expect(sent('yt:play')).toEqual([{ type: 'yt:play', position: 12.3 }]);
  });

  test('a background-tab pause (mobile) is not shared', async () => {
    const { p } = await mount(shared());
    act(() => p.fire(PlayerState.PLAYING));
    tick(1500);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => p.fire(PlayerState.PAUSED));
    expect(sent('yt:pause')).toEqual([]);
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
  async function inSync() {
    const start = Date.now();
    const m = await mount(shared({ updatedAt: start }));
    m.p.state = PlayerState.PLAYING;
    const expected = () => (Date.now() - start) / 1000;
    m.p.timeFn = expected;
    tick(2000); // past the suppression window, in sync
    m.p.calls.length = 0;
    return { ...m, drift: (d: number) => { m.p.timeFn = () => expected() + d; } };
  }

  test('> 1.5 s off: hard seek to the shared position', async () => {
    const { p, drift } = await inSync();
    drift(2);
    tick(1000);
    expect(p.calls).toEqual([['seek', 3]]);
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
    const { p, drift } = await inSync();
    p.duration = 1;
    drift(5);
    tick(1000);
    expect(p.calls).toEqual([]);
  });
});

describe('blocked autoplay', () => {
  test('asks for a click when the player will not start, and the click starts it', async () => {
    const { p } = await mount(shared());
    p.state = PlayerState.CUED; // the browser refused to autoplay
    tick(6000);
    const join = screen.getByRole('button', { name: /join the watch party/ });
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
    expect(screen.getByLabelText('Pause')).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Queue' })).toBeDisabled();
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
    fireEvent.click(screen.getByLabelText('Pause'));
    expect(notify).toHaveBeenCalledWith('Not connected to the bot — can’t sync');
  });

  test('transport buttons send the local position; skips are clamped', async () => {
    const { p } = await mount(shared());
    p.time = 4;
    fireEvent.click(screen.getByLabelText('Pause'));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:pause', position: 4 });
    fireEvent.click(screen.getByLabelText('Back 10 seconds'));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:seek', position: 0 });
    tick(1000); // UI learns the duration (200 s)
    p.time = 195;
    fireEvent.click(screen.getByLabelText('Forward 10 seconds'));
    expect(sendYoutube).toHaveBeenLastCalledWith({ type: 'yt:seek', position: 199.5 });
  });

  test('nothing on: placeholder, no controls', async () => {
    await mount(null);
    expect(screen.getByText(/Nothing on yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Pause')).not.toBeInTheDocument();
  });
});
