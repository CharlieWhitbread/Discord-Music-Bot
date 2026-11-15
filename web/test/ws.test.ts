import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Browser-like fake: close() is async (onclose fires on a later task),
 * exactly the window in which the StrictMode remount race happens.
 */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('InvalidStateError');
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
    setTimeout(() => this.finishClose(), 0);
  }

  /* test controls */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Server/network drop. */
  drop() {
    this.readyState = FakeSocket.CLOSING;
    this.finishClose();
  }

  finishClose() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const live = () => FakeSocket.instances.filter((s) => s.readyState <= FakeSocket.OPEN);

let ws: typeof import('../src/ws');

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  localStorage.setItem('soundboard_token', 'tok');
  vi.resetModules();
  ws = await import('../src/ws');
});

afterEach(() => {
  ws.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected() {
  const states: string[] = [];
  ws.subscribe({ onState: (s) => states.push(s) });
  ws.connect();
  const sock = FakeSocket.instances.at(-1)!;
  sock.open();
  sock.receive({ type: 'auth', ok: true });
  return { sock, states };
}

describe('connection', () => {
  test('authenticates on open and reports state transitions', async () => {
    const { sock, states } = await connected();
    expect(sock.url).toBe('ws://api.test/ws');
    expect(sock.sent[0]).toEqual({ type: 'auth', token: 'tok' });
    expect(states).toEqual(['closed', 'connecting', 'open']);
  });

  test('does nothing without a token, and never opens a second socket', () => {
    localStorage.clear();
    ws.connect();
    expect(FakeSocket.instances).toHaveLength(0);
    localStorage.setItem('soundboard_token', 'tok');
    ws.connect();
    ws.connect();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('dispatches every server frame type to listeners', async () => {
    const seen: string[] = [];
    let offset = 0;
    ws.subscribe({
      onStatus: () => seen.push('status'),
      onSpotify: () => seen.push('spotify'),
      onQueue: () => seen.push('queue'),
      onPlaylists: () => seen.push('playlists'),
      onError: (e) => seen.push(`error:${e}`),
      onYoutube: (_s, o) => { seen.push('youtube'); offset = o; },
    });
    const { sock } = await connected();
    vi.setSystemTime(1_000_000);
    for (const type of ['status', 'spotify', 'queue', 'playlists']) sock.receive({ type });
    sock.receive({ type: 'youtube', youtube: {}, serverNow: 1_000_250 });
    sock.receive({ type: 'error', error: 'nope' });
    expect(seen).toEqual(['status', 'spotify', 'queue', 'playlists', 'youtube', 'error:nope']);
    expect(offset).toBe(250);
  });

  test('unsubscribe stops delivery', async () => {
    const onStatus = vi.fn();
    const off = ws.subscribe({ onStatus });
    const { sock } = await connected();
    off();
    sock.receive({ type: 'status', status: {} });
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('reconnect', () => {
  test('backs off 1 s, 2 s, 4 s … capped at 15 s, reset by a successful auth', async () => {
    const { sock } = await connected();
    sock.drop();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
      FakeSocket.instances.at(-1)!.drop(); // fails again
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);

    vi.advanceTimersByTime(15_000);
    const ok = FakeSocket.instances.at(-1)!;
    ok.open();
    ok.receive({ type: 'auth', ok: true });
    ok.drop();
    const before = FakeSocket.instances.length;
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBe(before + 1);
  });

  test('a rejected token does not reconnect once the token is cleared', async () => {
    ws.connect();
    const sock = FakeSocket.instances[0];
    sock.open();
    sock.receive({ type: 'auth', ok: false });
    localStorage.clear(); // api.ts clears it on 401 and reloads
    sock.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('disconnect() cancels a pending reconnect', async () => {
    const { sock } = await connected();
    sock.drop();
    ws.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('StrictMode remount: the old socket’s late onclose does not clobber the new one', async () => {
    const states: string[] = [];
    ws.subscribe({ onState: (s) => states.push(s) });
    ws.connect(); // mount
    ws.disconnect(); // StrictMode unmount: A.close() is async
    ws.connect(); // remount → B
    const [a, b] = FakeSocket.instances;
    b.open();
    b.receive({ type: 'auth', ok: true });
    vi.advanceTimersByTime(0); // A's onclose lands now
    expect(a.readyState).toBe(FakeSocket.CLOSED);

    vi.advanceTimersByTime(60_000);
    expect(live()).toEqual([b]);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(states.at(-1)).toBe('open');
    expect(ws.sendPlay(1)).toBe(true);
    expect(b.sent.at(-1)).toEqual({ type: 'play', clipId: 1 });
  });

  test('messages from a superseded socket are ignored', async () => {
    const onStatus = vi.fn();
    ws.subscribe({ onStatus });
    ws.connect();
    const a = FakeSocket.instances[0];
    a.open();
    ws.disconnect();
    ws.connect();
    a.receive({ type: 'status', status: { stale: true } });
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('senders', () => {
  test('return false (→ HTTP fallback) unless the socket is open and authed', async () => {
    expect(ws.sendPlay(1)).toBe(false);
    ws.connect();
    const sock = FakeSocket.instances[0];
    sock.open();
    expect(ws.sendStop()).toBe(false); // open but not yet authed
    sock.receive({ type: 'auth', ok: true });
    expect(ws.sendPlay(7)).toBe(true);
    expect(ws.sendStop()).toBe(true);
    expect(ws.sendVolume(40)).toBe(true);
    expect(ws.sendSpotifyTransport('pause')).toBe(true);
    expect(ws.sendYoutube({ type: 'yt:seek', position: 3 })).toBe(true);
    expect(sock.sent.slice(1)).toEqual([
      { type: 'play', clipId: 7 }, { type: 'stop' }, { type: 'volume', value: 40 },
      { type: 'spotify:pause' }, { type: 'yt:seek', position: 3 },
    ]);
  });

  test('a frame whose handler throws does not stop later frames (browser semantics)', async () => {
    const onStatus = vi.fn();
    ws.subscribe({ onStatus });
    const { sock } = await connected();
    expect(() => sock.onmessage?.({ data: 'not json' })).toThrow(SyntaxError);
    sock.receive({ type: 'status', status: {} });
    expect(onStatus).toHaveBeenCalledTimes(1);
  });
});
