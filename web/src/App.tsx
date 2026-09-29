import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { captureTokenFromUrl, clearToken, getToken } from './auth';
import * as ws from './ws';
import type { BotStatus, Clip, ConnectionState, User } from './types';
import Login from './components/Login';
import StatusBanner from './components/StatusBanner';
import SoundboardGrid from './components/SoundboardGrid';
import UploadModal from './components/UploadModal';

export default function App() {
  const [loginError] = useState<string | null>(() => captureTokenFromUrl());
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wsState, setWsState] = useState<ConnectionState>('closed');
  const [showUpload, setShowUpload] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshClips = useCallback(() => {
    api.clips().then(setClips).catch(() => notify('Failed to load clips'));
  }, [notify]);

  /* Session bootstrap */
  useEffect(() => {
    if (!getToken()) {
      setAuthChecked(true);
      return;
    }
    api.me()
      .then((me) => {
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

  if (!authChecked) return null;

  if (!user) {
    return <Login error={loginError} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Soundboard</h1>
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

      <SoundboardGrid
        clips={clips}
        nowPlayingId={status?.clip?.id ?? null}
        disabled={!status?.inVoice}
        currentUserId={user.userId}
        onPlay={playClip}
        onDelete={deleteClip}
      />

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); refreshClips(); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
