import { useState } from 'react';
import { api } from '../api';
import type { QueueEntry } from '../types';

interface Props {
  queue: QueueEntry[];
  onClose: () => void;
  onAddSongs: () => void;
  onNotify: (msg: string) => void;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function QueuePanel({ queue, onClose, onAddSongs, onNotify }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);

  const remove = (entry: QueueEntry) => {
    setBusyId(entry.id);
    api.spotifyQueueRemove(entry.id)
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyId(null));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal spotify-search" onClick={(e) => e.stopPropagation()}>
        <h2>Up next</h2>
        <div className="track-results">
          {queue.length === 0 && (
            <p className="muted">The queue is empty — add songs from the search.</p>
          )}
          {queue.map((entry, i) => (
            <div key={entry.id} className="track-row">
              <span className="queue-pos muted">{i + 1}</span>
              {entry.track.image
                ? <img className="track-art" src={entry.track.image} alt="" />
                : <div className="track-art track-art-empty">🎵</div>}
              <div className="track-meta">
                <span className="track-name" title={entry.track.name}>{entry.track.name}</span>
                <span className="track-artist" title={entry.track.artists}>
                  {entry.track.artists} · {fmtDuration(entry.track.durationMs)} · added by {entry.addedBy.username}
                </span>
              </div>
              <div className="track-actions">
                <button
                  className="btn"
                  disabled={busyId === entry.id}
                  onClick={() => remove(entry)}
                  aria-label={`Remove ${entry.track.name}`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={onAddSongs}>+ Add songs</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
