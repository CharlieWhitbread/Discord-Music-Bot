import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import type { Clip } from '../src/types';

const yt = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('../src/ws', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  sendPlay: vi.fn(() => false),
  sendStop: vi.fn(() => false),
  sendYoutube: vi.fn(() => true),
  sendVolume: vi.fn(() => false),
  sendSpotifyTransport: vi.fn(() => false),
}));

vi.mock('../src/components/YouTubeTab', () => ({
  default: function YouTubeTabStub() {
    useEffect(() => {
      yt.mounts++;
      return () => { yt.unmounts++; };
    }, []);
    return <div data-testid="youtube-player" />;
  },
}));

const { default: App } = await import('../src/App');

const clip = (id: number): Clip => ({
  id, name: `Clip ${id}`, emoji: null, color: null, tags: [], durationMs: 1000, uploaderId: 'alice',
  uploaderName: 'Alice', playCount: 0, createdAt: 0,
});

beforeEach(() => {
  yt.mounts = 0;
  yt.unmounts = 0;
  localStorage.setItem('soundboard_token', 'tok');
  vi.spyOn(api, 'me').mockResolvedValue({ userId: 'alice', username: 'Alice', avatar: null });
  vi.spyOn(api, 'clips').mockResolvedValue([clip(1), clip(2)]);
  vi.spyOn(api, 'status').mockResolvedValue({ inVoice: true, clip: null, spotifyActive: false });
  vi.spyOn(api, 'spotifyStatus').mockResolvedValue({ configured: false, connected: false, canConnect: false, playlists: false });
  vi.spyOn(api, 'spotifyQueueList').mockResolvedValue([]);
  vi.spyOn(api, 'playlists').mockResolvedValue([]);
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
});

async function renderApp() {
  render(<App />);
  await screen.findAllByTitle(/^Clip 1 ·/);
}
const panel = (id: string) => document.getElementById(`panel-${id}`)!;
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });

describe('tabs and hash routing', () => {
  test('starts on the soundboard; other panels are mounted but inactive', async () => {
    await renderApp();
    expect(tab('Soundboard')).toHaveAttribute('aria-selected', 'true');
    expect(panel('soundboard')).not.toHaveClass('inactive');
    expect(panel('spotify')).toHaveClass('inactive');
    expect(screen.queryByTestId('youtube-player')).not.toBeInTheDocument();
  });

  test('clicking a tab selects it and records it in the URL hash', async () => {
    await renderApp();
    await userEvent.click(tab('Spotify'));
    expect(window.location.hash).toBe('#spotify');
    expect(tab('Spotify')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Spotify')).toHaveAttribute('tabindex', '0');
    expect(tab('Soundboard')).toHaveAttribute('tabindex', '-1');
    expect(panel('spotify')).not.toHaveClass('inactive');
    expect(panel('soundboard')).toHaveClass('inactive');
  });

  test('the YouTube player mounts on first visit and stays mounted on other tabs', async () => {
    await renderApp();
    await userEvent.click(tab('YouTube'));
    expect(screen.getByTestId('youtube-player')).toBeInTheDocument();
    await userEvent.click(tab('Soundboard'));
    await userEvent.click(tab('Spotify'));
    expect(screen.getByTestId('youtube-player')).toBeInTheDocument();
    expect(panel('youtube')).toHaveClass('inactive');
    expect(yt).toEqual({ mounts: 1, unmounts: 0 });
  });

  test('back/forward (hashchange) switches tabs', async () => {
    await renderApp();
    await act(async () => {
      window.location.hash = '#youtube';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('youtube-player')).toBeInTheDocument();
    await act(async () => {
      window.location.hash = '#nonsense';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(tab('Soundboard')).toHaveAttribute('aria-selected', 'true');
  });

  test('a deep link to #youtube mounts the player straight away', async () => {
    window.location.hash = '#youtube';
    await renderApp();
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('youtube-player')).toBeInTheDocument();
  });

  test('arrow keys move between tabs and wrap around', async () => {
    await renderApp();
    tab('Soundboard').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    expect(tab('YouTube')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tab('Soundboard')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('favourites and recents', () => {
  const favSection = () => screen.queryByRole('heading', { name: '★ Favourites' })?.closest('section') ?? null;

  test('starring is optimistic and reconciles with the server list', async () => {
    let resolve!: (ids: number[]) => void;
    const set = vi.spyOn(api, 'setFavorite').mockReturnValue(new Promise((r) => { resolve = r; }));
    await renderApp();
    const star = within(screen.getAllByTitle(/^Clip 2 ·/)[0]).getByTitle('Add to favourites');
    await userEvent.click(star);
    expect(set).toHaveBeenCalledWith(2, true);
    expect(within(favSection()!).getByText('Clip 2')).toBeInTheDocument();
    await act(async () => resolve([2]));
    expect(within(favSection()!).getByText('Clip 2')).toBeInTheDocument();

    set.mockResolvedValue([]);
    await userEvent.click(within(within(favSection()!).getByTitle(/^Clip 2 ·/)).getByTitle('Remove from favourites'));
    expect(set).toHaveBeenLastCalledWith(2, false);
    await waitFor(() => expect(favSection()).toBeNull());
  });

  test('a failed star rolls back and shows the error', async () => {
    vi.spyOn(api, 'setFavorite').mockRejectedValue(new ApiError('Clip not found', 404));
    await renderApp();
    await userEvent.click(within(screen.getByTitle(/^Clip 1 ·/)).getByTitle('Add to favourites'));
    await waitFor(() => expect(favSection()).toBeNull());
    expect(screen.getByText('Clip not found')).toHaveClass('toast');
  });

  test('server favourites load at startup; unknown ids are skipped', async () => {
    vi.spyOn(api, 'favorites').mockResolvedValue([99, 1]);
    await renderApp();
    await waitFor(() => expect(favSection()).not.toBeNull());
    expect(within(favSection()!).getAllByRole('button', { name: /Clip/ })).toHaveLength(1);
  });

  test('playing a clip (HTTP fallback) adds it to Recent', async () => {
    const play = vi.spyOn(api, 'play').mockResolvedValue({ ok: true });
    await renderApp();
    await userEvent.click(screen.getByTitle(/^Clip 2 ·/));
    expect(play).toHaveBeenCalledWith(2);
    const recent = screen.getByRole('heading', { name: '🕘 Recent' }).closest('section')!;
    expect(within(recent).getByText('Clip 2')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('soundboard_recent')!)).toEqual([2]);
  });

  test('quick-access rows hide while searching', async () => {
    vi.spyOn(api, 'favorites').mockResolvedValue([1]);
    await renderApp();
    await waitFor(() => expect(favSection()).not.toBeNull());
    await userEvent.type(screen.getByPlaceholderText('Search clips…'), 'clip 2');
    expect(favSection()).toBeNull();
    expect(screen.queryByTitle(/^Clip 1 ·/)).not.toBeInTheDocument();
  });
});

test('signed out: shows the login screen', async () => {
  localStorage.clear();
  vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Not authenticated', 401));
  render(<App />);
  expect(await screen.findByText('Sign in with Discord')).toBeInTheDocument();
});
