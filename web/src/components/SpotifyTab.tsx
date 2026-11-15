import { useCallback, useState } from 'react';
import { api } from '../api';
import type { BotStatus, Playlist, QueueEntry, SpotifyState, SpotifyStatus, User } from '../types';
import NowPlayingBar from './NowPlayingBar';
import QueuePanel from './QueuePanel';
import SpotifySearchModal from './SpotifySearchModal';
import PlaylistGrid from './PlaylistGrid';
import PlaylistModal from './PlaylistModal';

interface Props {
  user: User;
  isAdmin: boolean;
  status: BotStatus | null;
  spotify: SpotifyState | null;
  spotifyStatus: SpotifyStatus | null;
  queue: QueueEntry[];
  playlists: Playlist[];
  onNotify: (msg: string) => void;
}

/** null = closed, 'new' = create form, otherwise the playlist being edited */
type Editing = null | 'new' | Playlist;

export default function SpotifyTab({
  user, isAdmin, status, spotify, spotifyStatus, queue, playlists, onNotify,
}: Props) {
  const [showSongSearch, setShowSongSearch] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const play = useCallback((playlist: Playlist) => {
    if (!status?.inVoice) {
      onNotify('The bot isn’t in a voice channel — run /join in Discord first');
      return;
    }
    if (playlist.trackCount === 0) {
      onNotify(`"${playlist.name}" is empty — add some songs first`);
      setEditing(playlist);
      return;
    }
    setBusyId(playlist.id);
    api.playPlaylist(playlist.id)
      .then(() => onNotify(`Playing ${playlist.emoji ?? '🎵'} ${playlist.name}${playlist.shuffle ? ' (shuffled)' : ''}`))
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyId(null));
  }, [status?.inVoice, onNotify]);

  const toggleShuffle = useCallback((playlist: Playlist) => {
    api.updatePlaylist(playlist.id, { shuffle: !playlist.shuffle })
      .catch((err) => onNotify(err.message));
  }, [onNotify]);

  if (!spotifyStatus?.configured) {
    return <p className="empty">Spotify isn’t configured on the bot.</p>;
  }

  const playingId = playlists.find(
    (p) => spotify?.active && spotify.context?.uri === `spotify:playlist:${p.spotifyId}`,
  )?.id ?? null;
  const playingPlaylist = playlists.find((p) => p.id === playingId) ?? null;
  // Show the freshest copy (WS updates) of whatever is being edited.
  const editingPlaylist = editing && editing !== 'new'
    ? playlists.find((p) => p.id === editing.id) ?? editing
    : null;

  return (
    <>
      <NowPlayingBar
        spotify={spotify}
        status={spotifyStatus}
        musicVolume={status?.musicVolume ?? 100}
        context={playingPlaylist}
        playlists={spotifyStatus.playlists ? playlists : null}
        onSearch={() => setShowSongSearch(true)}
        onError={onNotify}
      />

      {spotifyStatus.connected && (
        <section className="panel">
          <div className="panel-header">
            <h2>Playlists</h2>
            {spotifyStatus.playlists && (
              <button className="btn primary" onClick={() => setEditing('new')}>+ New playlist</button>
            )}
          </div>
          {spotifyStatus.playlists ? (
            <PlaylistGrid
              playlists={playlists}
              playingId={playingId}
              busyId={busyId}
              onPlay={play}
              onEdit={setEditing}
              onToggleShuffle={toggleShuffle}
            />
          ) : (
            <div className="reconnect">
              <p>
                Playlists need extra Spotify permissions, so Spotify has to be reconnected once.
                {!spotifyStatus.canConnect && ' Ask an admin to do it.'}
              </p>
              {spotifyStatus.canConnect && (
                <a className="btn primary" href={api.spotifyLoginUrl()}>Reconnect Spotify</a>
              )}
            </div>
          )}
        </section>
      )}

      {spotifyStatus.connected && (
        <QueuePanel
          queue={queue}
          onAddSongs={() => setShowSongSearch(true)}
          onNotify={onNotify}
        />
      )}

      {showSongSearch && (
        <SpotifySearchModal
          playlists={spotifyStatus.playlists ? playlists : null}
          onClose={() => setShowSongSearch(false)}
          onNotify={onNotify}
        />
      )}

      {editing && (
        <PlaylistModal
          key={editing === 'new' ? 'new' : editing.id}
          playlist={editingPlaylist}
          canManage={editing === 'new' || isAdmin || editingPlaylist?.creatorId === user.userId}
          onClose={() => setEditing(null)}
          onCreated={setEditing}
          onPlay={(p) => {
            play(p);
            setEditing(null);
          }}
          onNotify={onNotify}
        />
      )}
    </>
  );
}
