import { useState } from 'react';
import { api } from '../api';
import type { Clip } from '../types';

export default function EditClipModal({
  clip,
  onClose,
  onSaved,
}: {
  clip: Clip;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(clip.name);
  const [emoji, setEmoji] = useState(clip.emoji ?? '');
  const [tags, setTags] = useState(clip.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError('A clip name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateClip(clip.id, {
        name: name.trim(),
        emoji: emoji.trim(),
        tags,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit clip</h2>

        <div className="field-row">
          <input
            type="text"
            placeholder="Clip name"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="emoji-input"
            type="text"
            placeholder="🔊"
            maxLength={4}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>

        <input
          type="text"
          className="tags-input"
          placeholder="Tags (comma separated, e.g. memes, boo)"
          maxLength={200}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
