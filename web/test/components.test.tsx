import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import SoundboardGrid from '../src/components/SoundboardGrid';
import QueuePanel from '../src/components/QueuePanel';
import AddToPlaylistMenu from '../src/components/AddToPlaylistMenu';
import SpotifyTab from '../src/components/SpotifyTab';
import type { Clip, Playlist, QueueEntry, SpotifyStatus, SpotifyTrack } from '../src/types';

const clip = (id: number, over: Partial<Clip> = {}): Clip => ({
  id, name: `Clip ${id}`, emoji: null, color: null, tags: [], durationMs: 1500, uploaderId: 'alice',
  uploaderName: 'Alice', playCount: 0, createdAt: 0, ...over,
});
const track = (n: number): SpotifyTrack => ({
  uri: `spotify:track:${n}`, name: `Song ${n}`, artists: 'Artist', album: 'Album', image: null, durationMs: 180_000,
});
const playlist = (id: number, over: Partial<Playlist> = {}): Playlist => ({
  id, spotifyId: `sp${id}`, name: `List ${id}`, emoji: null, tags: [], shuffle: false, trackCount: 0,
  creatorId: 'alice', creatorName: 'Alice', playCount: 0, createdAt: 0, ...over,
});

describe('SoundboardGrid', () => {
  function setup(props: Partial<Parameters<typeof SoundboardGrid>[0]> = {}) {
    const handlers = { onPlay: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onToggleFavorite: vi.fn() };
    render(
      <SoundboardGrid
        clips={[clip(1, { tags: ['hype mode'] }), clip(2, { uploaderId: 'bob' })]}
        nowPlayingId={null}
        disabled={false}
        currentUserId="alice"
        isAdmin={false}
        favoriteIds={new Set([2])}
        {...handlers}
        {...props}
      />,
    );
    return handlers;
  }
  const tile = (name: string) => screen.getByTitle(new RegExp(`^${name} ·`));

  test('the star toggles a favourite without playing the clip', async () => {
    const h = setup();
    const star = within(tile('Clip 1')).getByTitle('Add to favourites');
    expect(star).toHaveAttribute('aria-pressed', 'false');
    expect(within(tile('Clip 2')).getByTitle('Remove from favourites')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(star);
    expect(h.onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(h.onPlay).not.toHaveBeenCalled();
  });

  test('clicking a tile plays it; tags are shown formatted', async () => {
    const h = setup();
    await userEvent.click(tile('Clip 1'));
    expect(h.onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(within(tile('Clip 1')).getByText('Hype Mode')).toBeInTheDocument();
  });

  test('when not in voice tiles do not play, but favourites still work', async () => {
    const h = setup({ disabled: true });
    await userEvent.click(tile('Clip 1'));
    expect(h.onPlay).not.toHaveBeenCalled();
    await userEvent.click(within(tile('Clip 1')).getByTitle('Add to favourites'));
    expect(h.onToggleFavorite).toHaveBeenCalled();
  });

  test('edit/delete only on your own clips unless admin', () => {
    setup();
    expect(within(tile('Clip 1')).queryByTitle('Edit clip')).toBeInTheDocument();
    expect(within(tile('Clip 2')).queryByTitle('Edit clip')).not.toBeInTheDocument();
    expect(within(tile('Clip 2')).queryByTitle('Delete clip')).not.toBeInTheDocument();
  });

  test('admins can manage every clip', () => {
    setup({ isAdmin: true });
    expect(within(tile('Clip 2')).getByTitle('Delete clip')).toBeInTheDocument();
  });

  test('empty state', () => {
    render(
      <SoundboardGrid clips={[]} nowPlayingId={null} disabled={false} currentUserId="a" isAdmin={false} favoriteIds={new Set()}
        onPlay={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onToggleFavorite={vi.fn()} emptyMessage="Nothing here" />,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
});

describe('QueuePanel', () => {
  const entry = (id: number, locked?: boolean): QueueEntry => ({
    id, track: track(id), addedBy: { userId: 'bob', username: 'Bob' }, addedAt: 0, locked,
  });

  test('the handed-over entry is locked: labelled "Up next", no remove button', () => {
    render(<QueuePanel queue={[entry(1, true), entry(2)]} onAddSongs={vi.fn()} onNotify={vi.fn()} />);
    expect(screen.getByText('Up next (2)')).toBeInTheDocument();
    expect(screen.getByTitle('Handed to Spotify — plays next')).toHaveTextContent('Up next');
    expect(screen.queryByLabelText('Remove Song 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remove Song 2')).toBeInTheDocument();
    expect(screen.getAllByText(/added by Bob/)).toHaveLength(2);
  });

  test('removing calls the API; a 409 (raced into Spotify) is reported', async () => {
    const remove = vi.spyOn(api, 'spotifyQueueRemove').mockRejectedValue(new ApiError('Already handed to Spotify — it plays next', 409));
    const onNotify = vi.fn();
    render(<QueuePanel queue={[entry(2)]} onAddSongs={vi.fn()} onNotify={onNotify} />);
    await userEvent.click(screen.getByLabelText('Remove Song 2'));
    expect(remove).toHaveBeenCalledWith(2);
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Already handed to Spotify — it plays next'));
    expect(screen.getByLabelText('Remove Song 2')).toBeEnabled();
  });

  test('empty queue', () => {
    render(<QueuePanel queue={[]} onAddSongs={vi.fn()} onNotify={vi.fn()} />);
    expect(screen.getByText(/queue is empty/)).toBeInTheDocument();
  });
});

describe('AddToPlaylistMenu', () => {
  const lists = [playlist(1, { emoji: '🚗', trackCount: 3 }), playlist(2)];
  const open = async (props: Partial<Parameters<typeof AddToPlaylistMenu>[0]> = {}) => {
    const onNotify = vi.fn();
    render(<AddToPlaylistMenu track={track(9)} playlists={lists} onNotify={onNotify} {...props} />);
    await userEvent.click(screen.getByRole('button', { name: '+ Playlist' }));
    return onNotify;
  };

  test('opens a menu of playlists and adds the track to the chosen one', async () => {
    const add = vi.spyOn(api, 'addPlaylistTrack').mockResolvedValue(track(9));
    const onNotify = await open();
    expect(screen.getByRole('button', { name: '+ Playlist' })).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('menuitem', { name: /List 1/ });
    expect(item).toHaveTextContent('3');
    await userEvent.click(item);
    expect(add).toHaveBeenCalledWith(1, 'spotify:track:9');
    await waitFor(() => expect(item).toBeDisabled());
    expect(item).toHaveTextContent('✓');
    expect(onNotify).toHaveBeenCalledWith('Added to 🚗 List 1');
  });

  test('"already in this playlist" (409) also shows the checkmark', async () => {
    vi.spyOn(api, 'addPlaylistTrack').mockRejectedValue(new ApiError('Already in this playlist', 409));
    const onNotify = await open();
    const item = screen.getByRole('menuitem', { name: /List 2/ });
    await userEvent.click(item);
    await waitFor(() => expect(item).toHaveTextContent('✓'));
    expect(onNotify).toHaveBeenCalledWith('Already in this playlist');
  });

  test('other failures leave it addable', async () => {
    vi.spyOn(api, 'addPlaylistTrack').mockRejectedValue(new ApiError('Spotify request failed', 502));
    await open();
    const item = screen.getByRole('menuitem', { name: /List 2/ });
    await userEvent.click(item);
    await waitFor(() => expect(item).toBeEnabled());
    expect(item).not.toHaveTextContent('✓');
  });

  test('Escape, outside clicks, scrolling and resizing close it', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ Playlist' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ Playlist' }));
    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // resize's target is window (not a Node) — this used to throw.
    await userEvent.click(screen.getByRole('button', { name: '+ Playlist' }));
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('clicks inside the menu keep it open', async () => {
    vi.spyOn(api, 'addPlaylistTrack').mockReturnValue(new Promise(() => {}));
    await open();
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: /List 1/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  test('no playlists yet', async () => {
    await open({ playlists: [] });
    expect(screen.getByText(/No playlists yet/)).toBeInTheDocument();
  });
});

describe('SpotifyTab + PlaylistModal', () => {
  const status: SpotifyStatus = { configured: true, connected: true, canConnect: false, playlists: true };
  const user = { userId: 'alice', username: 'Alice', avatar: null };

  function renderTab(over: Partial<Parameters<typeof SpotifyTab>[0]> = {}) {
    const onNotify = vi.fn();
    const utils = render(
      <SpotifyTab user={user} isAdmin={false} status={{ inVoice: true, clip: null, spotifyActive: false }}
        spotify={null} spotifyStatus={status} queue={[]} playlists={[]} onNotify={onNotify} {...over} />,
    );
    return { onNotify, ...utils };
  }

  test('create → edit flow: create, then add songs found by search', async () => {
    const created = playlist(5, { name: 'Road trip', tags: ['drive'] });
    const createSpy = vi.spyOn(api, 'createPlaylist').mockResolvedValue(created);
    const tracksSpy = vi.spyOn(api, 'playlistTracks').mockResolvedValue([]);
    vi.spyOn(api, 'spotifySearch').mockResolvedValue([track(1), track(2)]);
    const addSpy = vi.spyOn(api, 'addPlaylistTrack').mockResolvedValue(track(1));
    renderTab();

    await userEvent.click(screen.getByRole('button', { name: '+ New playlist' }));
    expect(screen.getByRole('heading', { name: 'New playlist' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create & add songs' }));
    expect(screen.getByText('A playlist name is required')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    await userEvent.type(screen.getByPlaceholderText(/Playlist name/), '  Road trip ');
    await userEvent.type(screen.getByPlaceholderText(/Tags/), 'drive');
    await userEvent.click(screen.getByRole('button', { name: 'Create & add songs' }));
    expect(createSpy).toHaveBeenCalledWith({ name: 'Road trip', emoji: '', tags: 'drive', shuffle: false });

    expect(await screen.findByRole('heading', { name: 'Edit playlist' })).toBeInTheDocument();
    expect(tracksSpy).toHaveBeenCalledWith(5);
    expect(await screen.findByText(/No songs yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ Play' })).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Search Spotify…'), 'song');
    const add = (await screen.findAllByRole('button', { name: '+ Add' }))[0];
    await userEvent.click(add);
    expect(addSpy).toHaveBeenCalledWith(5, 'spotify:track:1');
    expect(await screen.findByText('Songs (1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✓ Added' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '▶ Play' })).toBeEnabled();
  });

  test('someone else’s playlist: details locked, songs and shuffle still editable', async () => {
    vi.spyOn(api, 'playlistTracks').mockResolvedValue([track(1)]);
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue(playlist(7));
    const bobs = playlist(7, { creatorId: 'bob', creatorName: 'Bob', trackCount: 1 });
    renderTab({ playlists: [bobs] });
    await userEvent.click(screen.getByTitle('Edit songs'));
    expect(screen.getByPlaceholderText(/Playlist name/)).toBeDisabled();
    expect(screen.getByText(/Only Bob or an admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(update).toHaveBeenCalledWith(7, { shuffle: true });
    expect(await screen.findByLabelText('Remove Song 1')).toBeEnabled();
  });

  test('a failed shuffle toggle rolls back', async () => {
    vi.spyOn(api, 'playlistTracks').mockResolvedValue([]);
    vi.spyOn(api, 'updatePlaylist').mockRejectedValue(new ApiError('Spotify request failed', 502));
    const { onNotify } = renderTab({ playlists: [playlist(3)] });
    await userEvent.click(screen.getByTitle('Edit songs'));
    const box = screen.getByRole('checkbox');
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(onNotify).toHaveBeenCalledWith('Spotify request failed');
  });

  test('playing an empty playlist opens it for editing instead', async () => {
    vi.spyOn(api, 'playlistTracks').mockResolvedValue([]);
    const play = vi.spyOn(api, 'playPlaylist');
    const { onNotify } = renderTab({ playlists: [playlist(3, { name: 'Empty' })] });
    await userEvent.click(screen.getByTitle(/^Empty ·/));
    expect(play).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('"Empty" is empty — add some songs first');
    expect(screen.getByRole('heading', { name: 'Edit playlist' })).toBeInTheDocument();
  });

  test('playing needs the bot in voice', async () => {
    const play = vi.spyOn(api, 'playPlaylist');
    const { onNotify } = renderTab({ status: { inVoice: false, clip: null, spotifyActive: false }, playlists: [playlist(3, { trackCount: 2 })] });
    await userEvent.click(screen.getByTitle(/^List 3 ·/));
    expect(play).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/isn’t in a voice channel/));
  });

  test('the tile’s shuffle toggle is open to anyone', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue(playlist(3));
    renderTab({ playlists: [playlist(3, { creatorId: 'bob' })] });
    await act(async () => { await userEvent.click(screen.getByTitle(/Shuffle off/)); });
    expect(update).toHaveBeenCalledWith(3, { shuffle: true });
  });

  test('without playlist scopes non-admins are told to ask an admin', () => {
    renderTab({ spotifyStatus: { ...status, playlists: false } });
    expect(screen.getByText(/Ask an admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New playlist' })).not.toBeInTheDocument();
  });
});
