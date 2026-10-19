// Offline timesheet queue. When a Submit fails with a network error (or the
// phone is offline) the full save payload is parked in localStorage and
// replayed through the SAME save path once the connection is back. Every
// localStorage call is guarded: private mode, a full quota or a blocked
// origin must never crash the form — the worker just gets the normal error.
//
// Item shape: { id, queuedAt, attempts, lastError, payload, photos, followUp, label }
//   payload  -> what persistTimesheet() takes (rpcArgs, headerPatch, linePatch)
//   photos   -> [{ dataUrl, caption }] (dropped when they would not fit)
//   followUp -> { signedOnSite, who } for the supervisor sign-off step
//   label    -> "Client · Project · date" for the banner / toasts

export const QUEUE_KEY = 'cbd_ts_queue';
export const QUEUE_EVENT = 'cbd_ts_queue_change';
export const QUEUE_SENT_EVENT = 'cbd_ts_queue_sent';

function emit() {
  try { window.dispatchEvent(new Event(QUEUE_EVENT)); } catch { /* no window */ }
}

export function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeQueue(items) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    emit();
    return true;
  } catch { return false; }
}

export function queueCount() { return readQueue().length; }

function newId() {
  try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch { /* fall through */ }
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Returns { ok, id, droppedPhotos }. If the item with photos does not fit the
// quota the photos are dropped and the hours still queue — hours matter more.
export function enqueue(item) {
  const id = newId();
  const base = { id, queuedAt: new Date().toISOString(), attempts: 0, lastError: null, ...item };
  const items = readQueue();
  if (writeQueue([...items, base])) return { ok: true, id, droppedPhotos: false };
  if (base.photos && base.photos.length) {
    const lean = { ...base, photos: [], photosDropped: base.photos.length };
    if (writeQueue([...items, lean])) return { ok: true, id, droppedPhotos: true };
  }
  return { ok: false, id: null, droppedPhotos: false };
}

export function removeQueued(id) {
  writeQueue(readQueue().filter(x => x.id !== id));
}

export function updateQueued(id, patch) {
  writeQueue(readQueue().map(x => x.id === id ? { ...x, ...patch } : x));
}

// Listener gets the current count; fires on same-tab writes and cross-tab
// storage events. Returns the unsubscribe function.
export function subscribeQueue(fn) {
  const handler = () => { try { fn(queueCount()); } catch { /* listener error */ } };
  try {
    window.addEventListener(QUEUE_EVENT, handler);
    window.addEventListener('storage', handler);
  } catch { /* no window */ }
  handler();
  return () => {
    try {
      window.removeEventListener(QUEUE_EVENT, handler);
      window.removeEventListener('storage', handler);
    } catch { /* no window */ }
  };
}

export function isOffline() {
  try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch { return false; }
}

// supabase-js does not throw on a dead connection: it hands back
// { error: { message: 'TypeError: Failed to fetch' } }. Browsers word it
// differently (Safari: "Load failed", Firefox: "NetworkError…").
export function isNetworkError(err) {
  if (isOffline()) return true;
  if (!err) return false;
  const msg = String(err.message || err.details || err).toLowerCase();
  return /failed to fetch|load failed|networkerror|network request failed|fetch failed|network error|econnreset|etimedout|timed out|the internet connection appears to be offline/.test(msg);
}

let replaying = false;

// Replays each queued item through sendOne(item) -> { ok, error, network }.
// Success removes the item; a network failure stops the run (still offline);
// any other failure is recorded on the item and the run moves on.
export async function replayQueue(sendOne, { onSent } = {}) {
  if (replaying) return { sent: 0, failed: 0, skipped: true };
  replaying = true;
  let sent = 0, failed = 0;
  try {
    for (const item of readQueue()) {
      let r;
      try { r = await sendOne(item); }
      catch (e) { r = { ok: false, error: e, network: isNetworkError(e) }; }
      if (r?.ok) {
        removeQueued(item.id);
        sent += 1;
        try { onSent?.(item, r); } catch { /* listener error */ }
      } else if (r?.network) {
        failed += 1;
        break;
      } else {
        failed += 1;
        updateQueued(item.id, { attempts: (item.attempts || 0) + 1, lastError: String(r?.error?.message || r?.error || 'Send failed') });
      }
    }
  } finally {
    replaying = false;
  }
  if (sent) { try { window.dispatchEvent(new Event(QUEUE_SENT_EVENT)); } catch { /* no window */ } }
  return { sent, failed, skipped: false };
}
