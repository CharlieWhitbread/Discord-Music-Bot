/**
 * Bearer-token auth. The OAuth callback on the Pi redirects back here with
 * the token in the URL fragment (never sent to any server); we stash it in
 * localStorage and strip the fragment.
 */

const KEY = 'soundboard_token';

export function captureTokenFromUrl(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const token = hash.get('token');
  const error = hash.get('error');
  if (token) {
    localStorage.setItem(KEY, token);
    history.replaceState(null, '', window.location.pathname);
  }
  if (error) {
    history.replaceState(null, '', window.location.pathname);
    return error;
  }
  return null;
}

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
