import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Playlist, SpotifyTrack } from '../types';
import { fmtDuration, useSpotifySearch } from '../useSpotifySearch';

interface Props {
  /** null = create a new playlist */
  playlist: Playlist | null;
  canManage: boolean;
  onClose: () => void;
  onCreated: (playlist: Playlist) => void;
  onPlay: (playlist: Playlist) => void;
  onNotify: (msg: string) => void;
}

function TrackArt({ track }: { track: SpotifyTrack }) {
  return track.image
    ? <img className="track-art" src={track.image} alt="" />
    : <div className="track-art track-art-empty">🎵</div>;
}

export default function PlaylistModal({ playlist, canManage, onClose, onCreated, onPlay, onNotify }: Props) {
  const creating = playlist === null;
  const [name, setName] = useState(playlist?.name ?? '');
  const [emoji, setEmoji] = useState(playlist?.emoji ?? '');
  const [tags, setTags] = useState(playlist?.tags.join(', ') ?? '');
  const [shuffle, setShuffle] = useState(playlist?.shuffle ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tracks, setTracks] = useState<SpotifyTrack[] | null>(null);
  const [busyUri, setBusyUri] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const { results, searching } = useSpotifySearch(query, onNotify);

  // Keep the shuffle toggle in sync with changes made from the tile.
  useEffect(() => {
    if (playlist) setShuffle(playlist.shuffle);
  }, [playlist?.shuffle]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTracks = useCallback(() => {
    if (!playlist) return;
    api.playlistTracks(playlist.id)
      .then(setTracks)
      .catch((err) => {
        setTracks([]);
        onNotify(err.message);
      });
  }, [playlist?.id, onNotify]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(loadTracks, [loadTracks]);

  const metaDirty = !creating && playlist && (
    name.trim() !== playlist.name ||
    emoji.trim() !== (playlist.emoji ?? '') ||
    tags !== playlist.tags.join(', ')
  );

  const create = async () => {
    if (!name.trim()) {
      setError('A playlist name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.createPlaylist({ name: name.trim(), emoji: emoji.trim(), tags, shuffle }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the playlist');
    } finally {
      setSaving(false);
    }
  };

  const saveMeta = async () => {
    if (!playlist || !name.trim()) {
      setError('A playlist name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.updatePlaylist(playlist.id, { name: name.trim(), emoji: emoji.trim(), tags });
      setTags(saved.tags.join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleShuffle = (next: boolean) => {
    setShuffle(next);
    if (!playlist) return;
    api.updatePlaylist(playlist.id, { shuffle: next }).catch((err) => {
      setShuffle(!next);
      onNotify(err.message);
    });
  };

  const addTrack = (track: SpotifyTrack) => {
    if (!playlist) return;
    setBusyUri(track.uri);
    api.addPlaylistTrack(playlist.id, track.uri)
      .then((added) => setTracks((cur) => [...(cur ?? []), added]))
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyUri(null));
  };

  const removeTrack = (track: SpotifyTrack) => {
    if (!playlist) return;
    setBusyUri(track.uri);
    api.removePlaylistTrack(playlist.id, track.uri)
      .then(() => setTracks((cur) => (cur ?? []).filter((t) => t.uri !== track.uri)))
      .catch((err) => onNotify(err.message))
      .finally(() => setBusyUri(null));
  };

  const remove = () => {
    if (!playlist || !window.confirm(`Delete the "${playlist.name}" playlist?`)) return;
    api.deletePlaylist(playlist.id)
      .then(onClose)
      .catch((err) => onNotify(err.message));
  };

  const inPlaylist = new Set((tracks ?? []).map((t) => t.uri));
  const detailsLocked = !creating && !canManage;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal playlist-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{creating ? 'New playlist' : 'Edit playlist'}</h2>

        <div className="field-row">
          <input
            type="text"
            placeholder="Playlist name (e.g. Rocket League)"
            maxLength={64}
            value={name}
            disabled={detailsLocked}
            autoFocus={creating}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="emoji-input"
            type="text"
            placeholder="🎵"
            maxLength={4}
            value={emoji}
            disabled={detailsLocked}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>
        <input
          type="text"
          className="tags-input"
          placeholder="Tags (comma separated, e.g. gaming, hype)"
          maxLength={200}
          value={tags}
          disabled={detailsLocked}
          onChange={(e) => setTags(e.target.value)}
        />
        <label className="toggle-row">
          <input type="checkbox" checked={shuffle} onChange={(e) => toggleShuffle(e.target.checked)} />
          <span>🔀 Shuffle when played</span>
        </label>
        {detailsLocked && (
          <p className="extract-note">Only {playlist?.creatorName} or an admin can rename or retag this playlist — anyone can edit the songs.</p>
        )}
        {error && <p className="modal-error">{error}</p>}

        {creating ? (
          <div className="modal-actions">
            <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn primary" onClick={create} disabled={saving}>
              {saving ? 'Creating…' : 'Create & add songs'}
            </button>
          </div>
        ) : (
          <>
            {metaDirty && canManage && (
              <div className="modal-actions">
                <button className="btn primary" onClick={saveMeta} disabled={saving}>
                  {saving ? 'Saving…' : 'Save details'}
                </button>
              </div>
            )}

            <section className="playlist-section">
              <h3>Songs{tracks ? ` (${tracks.length})` : ''}</h3>
              <div className="track-results">
                {tracks === null && <p className="muted">Loading…</p>}
                {tracks?.length === 0 && <p className="muted">No songs yet — search below to add some.</p>}
                {tracks?.map((track) => (
                  <div key={track.uri} className="track-row">
                    <TrackArt track={track} />
                    <div className="track-meta">
                      <span className="track-name" title={track.name}>{track.name}</span>
                      <span className="track-artist" title={track.artists}>
                        {track.artists} · {fmtDuration(track.durationMs)}
                      </span>
                    </div>
                    <div className="track-actions">
                      <button
                        className="btn"
                        disabled={busyUri === track.uri}
                        onClick={() => removeTrack(track)}
                        aria-label={`Remove ${track.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="playlist-section">
              <h3>Add songs</h3>
              <input
                type="search"
                className="search-input"
                placeholder="Search Spotify…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="track-results">
                {searching && results.length === 0 && <p className="muted">Searching…</p>}
                {!searching && query.trim() && results.length === 0 && <p className="muted">No results</p>}
                {results.map((track) => {
                  const added = inPlaylist.has(track.uri);
                  return (
                    <div key={track.uri} className="track-row">
                      <TrackArt track={track} />
                      <div className="track-meta">
                        <span className="track-name" title={track.name}>{track.name}</span>
                        <span className="track-artist" title={track.artists}>
                          {track.artists} · {fmtDuration(track.durationMs)}
                        </span>
                      </div>
                      <div className="track-actions">
                        <button
                          className={`btn${added ? '' : ' primary'}`}
                          disabled={added || busyUri === track.uri}
                          onClick={() => addTrack(track)}
                        >
                          {added ? '✓ Added' : '+ Add'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="modal-actions">
              {canManage && (
                <button className="btn danger" onClick={remove}>Delete</button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={onClose}>Close</button>
              <button
                className="btn primary"
                disabled={!tracks?.length}
                onClick={() => playlist && onPlay(playlist)}
              >
                ▶ Play
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
