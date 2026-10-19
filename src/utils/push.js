// Web push (browser notifications) — client side.
//
// A subscription is a browser-generated endpoint + two keys; we store it in
// `push_subscriptions` under the signed-in worker (RLS: own rows only). The
// `send-push` edge function encrypts a payload for that endpoint and the push
// service (Google / Apple / Mozilla) delivers it even when the tab is closed.
//
// Permission is only ever requested from subscribe() — call it from a tap,
// never on page load (browsers block unprompted requests, and users hate them).
//
// iOS: push only works for the INSTALLED app (Add to Home Screen, iOS 16.4+).
// In mobile Safari proper, isSupported() is false.

import { supabase } from '../supabaseClient';

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || '';
const SW_URL = '/sw.js';

export function isSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && !!VAPID_PUBLIC_KEY;
}

// 'granted' | 'denied' | 'default' | 'unsupported'
export function getPermission() {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function bytesToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getRegistration() {
  // index.js registers the SW in production only; registering again is a no-op.
  const reg = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  return reg;
}

// { permission, subscribed, endpoint } — subscribed = this browser holds a live
// subscription (we don't hit the DB here; the DB row is upserted on subscribe()).
export async function getState() {
  const permission = getPermission();
  if (permission === 'unsupported') return { permission, subscribed: false, endpoint: null };
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return { permission, subscribed: !!sub, endpoint: sub?.endpoint || null };
  } catch {
    return { permission, subscribed: false, endpoint: null };
  }
}

// Ask permission (tap-initiated), subscribe this browser, save the row.
// Resolves { ok: true } or { ok: false, reason: 'unsupported'|'denied'|'subscribe_failed'|'save_failed', detail? }.
export async function subscribe(workerId) {
  if (!isSupported()) return { ok: false, reason: 'unsupported' };
  if (!workerId) return { ok: false, reason: 'save_failed', detail: 'no worker id' };
  let permission = Notification.permission;
  if (permission !== 'granted') {
    try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  let sub;
  try {
    const reg = await getRegistration();
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY),
      });
    }
  } catch (e) {
    return { ok: false, reason: 'subscribe_failed', detail: e?.message };
  }

  const json = sub.toJSON();
  const row = {
    worker_id: workerId,
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh || bytesToB64url(sub.getKey('p256dh')),
    auth: json.keys?.auth || bytesToB64url(sub.getKey('auth')),
    user_agent: (navigator.userAgent || '').slice(0, 300),
    last_seen_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (error) return { ok: false, reason: 'save_failed', detail: error.message };
  return { ok: true, endpoint: sub.endpoint };
}

// Unsubscribe this browser and delete its row (own rows only via RLS).
export async function unsubscribe() {
  if (!isSupported()) return { ok: true };
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e?.message };
  }
}

// True on iPhone/iPad Safari when NOT running as the installed app — push is
// unavailable there until the user adds the portal to the Home Screen.
export function needsHomeScreenInstall() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
  return isIOS && !standalone;
}
