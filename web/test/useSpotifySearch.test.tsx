import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from '../src/api';
import { useSpotifySearch } from '../src/useSpotifySearch';
import type { SpotifyTrack } from '../src/types';

const track = (name: string): SpotifyTrack => ({ uri: `spotify:track:${name}`, name, artists: 'A', album: 'B', image: null, durationMs: 1000 });

/** Search stub whose responses the test resolves by hand, in any order. */
function deferredSearch() {
  const pending = new Map<string, { resolve: (t: SpotifyTrack[]) => void; reject: (e: Error) => void }>();
  const spy = vi.spyOn(api, 'spotifySearch').mockImplementation((q) => new Promise((resolve, reject) => {
    pending.set(q, { resolve, reject });
  }));
  return { spy, pending };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const onError = vi.fn();
const render = (query: string) => renderHook(({ q }) => useSpotifySearch(q, onError), { initialProps: { q: query } });

describe('useSpotifySearch', () => {
  test('debounces 350 ms and only searches the latest query', async () => {
    const { spy } = deferredSearch();
    const { rerender, result } = render('a');
    rerender({ q: 'ab' });
    rerender({ q: 'abc' });
    expect(result.current.searching).toBe(true);
    act(() => { vi.advanceTimersByTime(349); });
    expect(spy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('abc');
  });

  test('trims the query and clears results for an empty one', async () => {
    const { spy, pending } = deferredSearch();
    const { rerender, result } = render('  hi  ');
    act(() => { vi.advanceTimersByTime(350); });
    expect(spy).toHaveBeenCalledWith('hi');
    await act(async () => { pending.get('hi')!.resolve([track('x')]); });
    expect(result.current.results).toHaveLength(1);
    rerender({ q: '   ' });
    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
  });

  test('a stale response that arrives late is ignored', async () => {
    const { pending } = deferredSearch();
    const { rerender, result } = render('old');
    act(() => { vi.advanceTimersByTime(350); });
    rerender({ q: 'new' });
    act(() => { vi.advanceTimersByTime(350); });
    await act(async () => { pending.get('new')!.resolve([track('new')]); });
    await act(async () => { pending.get('old')!.resolve([track('old')]); });
    expect(result.current.results.map((t) => t.name)).toEqual(['new']);
    expect(result.current.searching).toBe(false);
  });

  test('a stale response does not end the newer search’s spinner', async () => {
    const { pending } = deferredSearch();
    const { rerender, result } = render('old');
    act(() => { vi.advanceTimersByTime(350); });
    rerender({ q: 'new' });
    act(() => { vi.advanceTimersByTime(350); });
    await act(async () => { pending.get('old')!.resolve([track('old')]); });
    expect(result.current.searching).toBe(true);
  });

  test('errors are reported', async () => {
    const { pending } = deferredSearch();
    render('x');
    act(() => { vi.advanceTimersByTime(350); });
    await act(async () => { pending.get('x')!.reject(new Error('Spotify request failed')); });
    expect(onError).toHaveBeenCalledWith('Spotify request failed');
  });

  test('unmounting cancels a pending debounce', () => {
    const { spy } = deferredSearch();
    const { unmount } = render('x');
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(spy).not.toHaveBeenCalled();
  });
});
