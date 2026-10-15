import { useEffect, useState } from 'react';

// Shows a bar while the phone has no connection, so a worker knows why a save
// did not go through instead of tapping Submit five times.
export function OfflineBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online) return null;
  return (
    <div role="status" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3000,
      background: '#b45309', color: '#fff', fontSize: 13, fontWeight: 600,
      textAlign: 'center', padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
    }}>
      📵 You are offline. Changes will not save until you are back online.
    </div>
  );
}
