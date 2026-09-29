export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  'http://localhost:3000';

export const WS_URL: string = `${API_BASE.replace(/^http/, 'ws')}/ws`;

// Discord user id shown admin controls in the UI (enforcement is server-side).
export const ADMIN_USER: string | null =
  (import.meta.env.VITE_ADMIN_USER as string | undefined)?.trim() || null;
