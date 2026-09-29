import type { Clip } from '../types';

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function SoundboardGrid({
  clips,
  nowPlayingId,
  disabled,
  currentUserId,
  isAdmin,
  onPlay,
  onEdit,
  onDelete,
  emptyMessage = 'No clips yet — add the first one!',
}: {
  clips: Clip[];
  nowPlayingId: number | null;
  disabled: boolean;
  currentUserId: string;
  isAdmin: boolean;
  onPlay: (clip: Clip) => void;
  onEdit: (clip: Clip) => void;
  onDelete: (clip: Clip) => void;
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
          className={`tile${nowPlayingId === clip.id ? ' playing' : ''}`}
          style={clip.color ? { borderColor: clip.color } : undefined}
          disabled={disabled}
          onClick={() => onPlay(clip)}
          title={`${clip.name} · ${formatDuration(clip.durationMs)} · by ${clip.uploaderName}`}
        >
          <span className="tile-emoji">{clip.emoji ?? '🔊'}</span>
          <span className="tile-name">{clip.name}</span>
          {clip.tags.length > 0 && (
            <span className="tile-tags">
              {clip.tags.map((tag) => (
                <span key={tag} className="tag-badge">{tag}</span>
              ))}
            </span>
          )}
          <span className="tile-meta">
            {formatDuration(clip.durationMs)} · {clip.playCount}▶
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
