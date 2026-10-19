import { useEffect, useState, useCallback } from 'react';
import { C, btnSmall } from '../../theme';
import { subscribeQueue, replayQueue, readQueue, removeQueued, isOffline } from '../../utils/offlineQueue';
import { replayQueuedTimesheet } from '../../utils/saveTimesheet';

// "1 timesheet waiting to send · Send now" — shown in the worker portal while
// anything sits in the offline queue. Replays on mount and on the browser's
// `online` event; the button is for impatient thumbs and for the case where
// the phone never fires `online` (common on iOS after a tunnel).
export function OfflineQueueBanner({ showToast }) {
  const [count, setCount] = useState(0);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (auto = false) => {
    if (sending) return;
    if (isOffline()) { if (!auto) showToast?.('Still offline — it will send as soon as you have signal.', 'info'); return; }
    setSending(true);
    try {
      const r = await replayQueue(replayQueuedTimesheet, {
        onSent: (item) => showToast?.(`Sent: ${item.label || 'queued timesheet'}`, 'success'),
      });
      if (!auto && r.sent === 0 && r.failed > 0) {
        const stuck = readQueue()[0];
        showToast?.(stuck?.lastError ? `Could not send: ${stuck.lastError}` : 'Could not send yet — try again when you have signal.', 'error');
      }
    } finally {
      setSending(false);
    }
  }, [sending, showToast]);

  useEffect(() => subscribeQueue(setCount), []);

  useEffect(() => {
    const onOnline = () => { send(true); };
    window.addEventListener('online', onOnline);
    if (readQueue().length) send(true);
    return () => window.removeEventListener('online', onOnline);
    // Mount + online only: re-running on every `send` identity change would
    // loop while `sending` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!count) return null;
  const items = readQueue();
  const stuck = items.find(i => i.attempts >= 3 && i.lastError);

  return (
    <div data-area="offline timesheet queue" style={{
      background: 'rgba(234,179,8,0.12)', borderBottom: '1px solid rgba(234,179,8,0.4)',
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: C.text,
    }}>
      <span>📵 <strong>{count} timesheet{count === 1 ? '' : 's'} waiting to send</strong>{stuck ? ` · last error: ${stuck.lastError}` : ' · saved on your phone'}</span>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button type="button" onClick={() => send(false)} disabled={sending} style={{ ...btnSmall, minHeight: 36, opacity: sending ? 0.6 : 1 }}>
          {sending ? 'Sending…' : 'Send now'}
        </button>
        {stuck && (
          <button type="button" style={{ ...btnSmall, minHeight: 36, color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)' }}
            onClick={() => { if (window.confirm('Discard this queued timesheet? The hours will be lost.')) removeQueued(stuck.id); }}>
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
