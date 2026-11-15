/**
 * Clips recently pressed on this device. Kept local on purpose: "recent"
 * is about what *you* reach for again, and it costs no round trip.
 */

const KEY = 'soundboard_recent';
const MAX_RECENT = 8;

export function loadRecent(): number[] {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

/** Move the clip to the front; returns the new list. */
export function pushRecent(current: number[], clipId: number): number[] {
  const next = [clipId, ...current.filter((id) => id !== clipId)].slice(0, MAX_RECENT);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
