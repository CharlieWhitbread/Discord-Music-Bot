import type { Clip } from '../types';
import { formatTag } from '../format';

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function SoundboardGrid({
  clips,
  nowPlayingId,
  disabled,
  currentUserId,
  isAdmin,
  favoriteIds,
  onPlay,
  onEdit,
  onDelete,
  onToggleFavorite,
  emptyMessage = 'No clips yet — add the first one!',
}: {
  clips: Clip[];
  nowPlayingId: number | null;
  disabled: boolean;
  currentUserId: string;
  isAdmin: boolean;
  favoriteIds: Set<number>;
  onPlay: (clip: Clip) => void;
  onEdit: (clip: Clip) => void;
  onDelete: (clip: Clip) => void;
  onToggleFavorite: (clip: Clip) => void;
  emptyMessage?: string;
}) {
  if (clips.length === 0) {
    return <p className="empty">{emptyMessage}</p>;
  }

  return (
    <div className="grid">
      {clips.map((clip) => (
        <button
          key={clip.id}
          className={`tile${nowPlayingId === clip.id ? ' playing' : ''}${disabled ? ' unavailable' : ''}`}
          style={clip.color ? { borderColor: clip.color } : undefined}
          // Not `disabled`: that would also swallow clicks on the star/edit icons.
          aria-disabled={disabled}
          onClick={() => { if (!disabled) onPlay(clip); }}
          title={`${clip.name} · ${formatDuration(clip.durationMs)} · by ${clip.uploaderName}`}
        >
          <span className="tile-emoji">{clip.emoji ?? '🔊'}</span>
          <span className="tile-name">{clip.name}</span>
          {clip.tags.length > 0 && (
            <span className="tile-tags">
              {clip.tags.map((tag) => (
                <span key={tag} className="tag-badge">{formatTag(tag)}</span>
              ))}
            </span>
          )}
          <span className="tile-meta">
            {formatDuration(clip.durationMs)} · {clip.playCount} ▶
          </span>
          <span
            className={`tile-fav${favoriteIds.has(clip.id) ? ' on' : ''}`}
            role="button"
            aria-pressed={favoriteIds.has(clip.id)}
            title={favoriteIds.has(clip.id) ? 'Remove from favourites' : 'Add to favourites'}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(clip); }}
          >
            {favoriteIds.has(clip.id) ? '★' : '☆'}
          </span>
          {(isAdmin || clip.uploaderId === currentUserId) && (
            <>
              <span
                className="tile-edit"
                role="button"
                title="Edit clip"
                onClick={(e) => { e.stopPropagation(); onEdit(clip); }}
              >
                ✎
              </span>
              <span
                className="tile-delete"
                role="button"
                title="Delete clip"
                onClick={(e) => { e.stopPropagation(); onDelete(clip); }}
              >
                ✕
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
