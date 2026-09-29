import { api } from '../api';

export default function Login({ error }: { error: string | null }) {
  return (
    <div className="login">
      <h1>Soundboard</h1>
      <p>Upload clips and play them in the Discord voice channel.</p>
      {error && <p className="login-error">{error}</p>}
      <a className="btn discord" href={api.loginUrl}>
        Sign in with Discord
      </a>
    </div>
  );
}
