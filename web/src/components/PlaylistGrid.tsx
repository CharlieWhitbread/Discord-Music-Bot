import type { Playlist } from '../types';
import { formatTag } from '../format';

interface Props {
  playlists: Playlist[];
  playingId: number | null;
  busyId: number | null;
  onPlay: (playlist: Playlist) => void;
  onEdit: (playlist: Playlist) => void;
  onToggleShuffle: (playlist: Playlist) => void;
}

export default function PlaylistGrid({
  playlists, playingId, busyId, onPlay, onEdit, onToggleShuffle,
}: Props) {
  if (playlists.length === 0) {
    return <p className="empty">No playlists yet — make one for your next session!</p>;
  }

  return (
    <div className="grid">
      {playlists.map((playlist) => (
        <button
          key={playlist.id}
          className={`tile playlist-tile${playingId === playlist.id ? ' playing' : ''}${busyId === playlist.id ? ' busy' : ''}`}
          aria-busy={busyId === playlist.id}
          onClick={() => onPlay(playlist)}
          title={`${playlist.name} · ${playlist.trackCount} songs · by ${playlist.creatorName}`}
        >
          <span className="tile-emoji">{playlist.emoji ?? '🎵'}</span>
          <span className="tile-name">{playlist.name}</span>
          {playlist.tags.length > 0 && (
            <span className="tile-tags">
              {playlist.tags.map((tag) => (
                <span key={tag} className="tag-badge">{formatTag(tag)}</span>
              ))}
            </span>
          )}
          <span className="tile-meta">
            {playlist.trackCount} {playlist.trackCount === 1 ? 'song' : 'songs'} · {playlist.playCount} ▶
          </span>
          <span
            className="tile-edit"
            role="button"
            title="Edit songs"
            onClick={(e) => { e.stopPropagation(); onEdit(playlist); }}
          >
            ✎
          </span>
          <span
            className={`tile-shuffle${playlist.shuffle ? ' on' : ''}`}
            role="button"
            aria-pressed={playlist.shuffle}
            title={playlist.shuffle ? 'Shuffle on — click to turn off' : 'Shuffle off — click to turn on'}
            onClick={(e) => { e.stopPropagation(); onToggleShuffle(playlist); }}
          >
            🔀
          </span>
        </button>
      ))}
    </div>
  );
}
