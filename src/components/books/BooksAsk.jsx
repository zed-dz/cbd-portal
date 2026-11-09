import { useState, useRef, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner } from '../index';

// "Ask the books" — a chat box that posts to portal-assistant with
// scope:'books'. The function picks from a fixed catalogue of read-only tools
// (books_sum / books_top / books_bas / books_ageing / books_exceptions) and
// answers only from their results. Money users only (403 for anyone else).

const STARTERS = [
  'What are the BAS figures for this quarter?',
  'Who owes us the most right now?',
  'What did we spend the most on in the last 3 months?',
  'Any duplicate payments I should check?',
];

export function BooksAsk({ disabled }) {
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [msgs]);

  const ask = async (text) => {
    const question = (text || q).trim();
    if (!question || loading) return;
    setQ('');
    setMsgs((m) => [...m, { role: 'you', text: question }]);
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('portal-assistant', { body: { question, scope: 'books', page: 'books' } });
      const answer = !error && data?.answer ? data.answer : (data?.error || error?.message || 'Sorry — I could not answer that just now.');
      setMsgs((m) => [...m, { role: 'books', text: answer, tools: data?.tools || [] }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'books', text: `Could not reach the assistant (${e?.message || 'network'}).` }]);
    }
    setLoading(false);
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
        Ask in plain words. Answers come only from the Books tables (cash basis). Payroll journals, manual journals and transfers are not here — read those in Xero.
      </p>
      {msgs.length === 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {STARTERS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={disabled} style={{
              background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: R.pill, padding: '8px 12px', fontSize: 12, cursor: 'pointer', minHeight: 36,
            }}>{s}</button>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 8, maxHeight: 420, overflowY: 'auto', paddingRight: 2 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ justifySelf: m.role === 'you' ? 'end' : 'start', maxWidth: '92%' }}>
            <div style={{
              background: m.role === 'you' ? C.accentSoft : C.bg, border: `1px solid ${m.role === 'you' ? C.accentBorder : C.border}`,
              borderRadius: R.lg, padding: '10px 12px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', lineHeight: 1.5, overflowWrap: 'anywhere',
            }}>{m.text}</div>
            {m.tools?.length ? <div style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, marginTop: 3 }}>read: {m.tools.join(', ')}</div> : null}
          </div>
        ))}
        {loading && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.textMuted, fontSize: 12 }}><Spinner size={16} /> reading the books…</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How much GST do we owe this quarter?" disabled={disabled || loading}
          style={{ ...inputStyle, flex: '1 1 200px', minHeight: 42 }} aria-label="Ask the books" />
        <button type="submit" disabled={disabled || loading || !q.trim()} style={{ ...btnPrimary, minHeight: 42, opacity: disabled || loading || !q.trim() ? 0.6 : 1 }}>Ask</button>
      </form>
    </div>
  );
}
