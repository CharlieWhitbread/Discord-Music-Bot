import { useState } from 'react';
import { api } from '../api';
import type { QueueEntry } from '../types';
import { fmtDuration } from '../useSpotifySearch';

interface Props {
  queue: QueueEntry[];
  onAddSongs: () => void;
  onNotify: (msg: string) => void;
}

export default function QueuePanel({ queue, onAddSongs, onNotify }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null);

  const remove = (entry: QueueEntry) => {
    setBusyId(entry.id);
    api.spotifyQueueRemove(entry.id)
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyId(null));
  };

  return (
    <section className="panel queue-panel">
      <div className="panel-header">
        <h2>Up next{queue.length > 0 ? ` (${queue.length})` : ''}</h2>
        <button className="btn primary" onClick={onAddSongs}>+ Add songs</button>
      </div>
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
              {entry.locked ? (
                <span className="queue-locked" title="Handed to Spotify — plays next">Up next</span>
              ) : (
                <button
                  className="btn"
                  disabled={busyId === entry.id}
                  onClick={() => remove(entry)}
                  aria-label={`Remove ${entry.track.name}`}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
