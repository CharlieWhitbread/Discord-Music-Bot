import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { ADMIN_USER } from './config';
import { captureTokenFromUrl, clearToken, getToken, setDevToken } from './auth';
import * as ws from './ws';
import type { BotStatus, Clip, ConnectionState, User } from './types';
import { formatTag } from './format';
import Login from './components/Login';
import StatusBanner from './components/StatusBanner';
import SoundboardGrid from './components/SoundboardGrid';
import UploadModal from './components/UploadModal';
import EditClipModal from './components/EditClipModal';

export default function App() {
  const [loginError] = useState<string | null>(() => captureTokenFromUrl());
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wsState, setWsState] = useState<ConnectionState>('closed');
  const [showUpload, setShowUpload] = useState(false);
  const [editClip, setEditClip] = useState<Clip | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshClips = useCallback(() => {
    api.clips().then(setClips).catch(() => notify('Failed to load clips'));
  }, [notify]);

  /* Session bootstrap. Probe /me even without a token — it succeeds when
     the server runs with AUTH_DISABLED (LAN dev), skipping the login. */
  useEffect(() => {
    api.me()
      .then((me) => {
        if (!getToken()) setDevToken();
        setUser(me);
        refreshClips();
        api.status().then(setStatus).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, [refreshClips]);

  /* Live status over WebSocket */
  useEffect(() => {
    if (!user) return;
    ws.connect();
    const unsubscribe = ws.subscribe({
      onStatus: setStatus,
      onState: setWsState,
      onError: notify,
    });
    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [user, notify]);

  const playClip = useCallback((clip: Clip) => {
    if (!ws.sendPlay(clip.id)) {
      api.play(clip.id).catch((err) => notify(err.message));
    }
  }, [notify]);

  const stopClip = useCallback(() => {
    if (!ws.sendStop()) {
      api.stop().catch(() => {});
    }
  }, []);

  const deleteClip = useCallback((clip: Clip) => {
    if (!window.confirm(`Delete "${clip.name}"?`)) return;
    api.deleteClip(clip.id)
      .then(refreshClips)
      .catch((err) => notify(err.message));
  }, [refreshClips, notify]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const clip of clips) {
      for (const tag of clip.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  }, [clips]);

  const toggleTag = (tag: string) =>
    setActiveTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));

  const visibleClips = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips.filter((clip) =>
      activeTags.every((tag) => clip.tags.includes(tag)) &&
      (!q || clip.name.toLowerCase().includes(q) || clip.tags.some((tag) => tag.includes(q))),
    );
  }, [clips, query, activeTags]);

  if (!authChecked) return null;

  if (!user) {
    return <Login error={loginError} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">🎉</span>
          <div>
            <h1>Mr Blobby</h1>
            <span className="brand-sub">Soundboard</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={() => setShowUpload(true)}>+ Add clip</button>
          <button className="btn" onClick={stopClip}>Stop</button>
          <div className="userchip">
            {user.avatar && <img src={user.avatar} alt="" />}
            <span>{user.username}</span>
            <button
              className="btn subtle"
              onClick={() => { clearToken(); window.location.reload(); }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <StatusBanner status={status} wsState={wsState} />

      {(clips.length > 0) && (
        <div className="filter-bar">
          <input
            type="search"
            className="search-input"
            placeholder="Search clips…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {allTags.length > 0 && (
            <div className="tag-chips">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  className={`tag-chip${activeTags.includes(tag) ? ' active' : ''}`}
                  onClick={() => toggleTag(tag)}
                >
                  {formatTag(tag)}
                </button>
              ))}
              {activeTags.length > 0 && (
                <button className="tag-chip clear" onClick={() => setActiveTags([])}>
                  ✕ clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <SoundboardGrid
        clips={visibleClips}
        nowPlayingId={status?.clip?.id ?? null}
        disabled={!status?.inVoice}
        currentUserId={user.userId}
        isAdmin={ADMIN_USER != null && user.userId === ADMIN_USER}
        onPlay={playClip}
        onEdit={setEditClip}
        onDelete={deleteClip}
        emptyMessage={clips.length > 0 ? 'No clips match your search' : undefined}
      />

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); refreshClips(); }}
        />
      )}

      {editClip && (
        <EditClipModal
          clip={editClip}
          onClose={() => setEditClip(null)}
          onSaved={() => { setEditClip(null); refreshClips(); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
