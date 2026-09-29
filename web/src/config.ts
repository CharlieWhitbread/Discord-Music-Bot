export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  'http://localhost:3000';

export const WS_URL: string = `${API_BASE.replace(/^http/, 'ws')}/ws`;
