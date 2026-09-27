import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnSmall } from '../../theme';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

// Sent Timesheets — the admin ledger of every client-PDF email attempt
// (Dashpivot parity prompt 2.3). One row per attempt from timesheet_sends:
// what was sent, to whom, via which provider, and the exact PDF bytes
// ("Open PDF" signs a URL into the private timesheet-pdfs bucket, so what
// you open is what the client received — not a rebuild). Resend re-invokes
// send-timesheet-pdf with force:true, which writes a NEW ledger row.
// RLS on timesheet_sends is admin-SELECT-only, so this page is empty for
// anyone else by construction.

const fmtStamp = (iso) => iso
  ? new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' })
  : '—';

const STATUS_CHIP = {
  sent:   { color: '#4ade80', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)' },
  failed: { color: '#f87171', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)' },
  queued: { color: '#eab308', bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.35)' },
};

function statusChip(status) {
  const s = STATUS_CHIP[status] || STATUS_CHIP.queued;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: R.pill,
      fontSize: 11, fontWeight: 700, fontFamily: '"DM Mono", monospace',
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      textTransform: 'uppercase', letterSpacing: 0.5,
    }}>{status || '—'}</span>
  );
}

export function SentTimesheetsPage({ showToast }) {
  const [sends, setSends] = useState([]);
  const [headerMap, setHeaderMap] = useState({});   // header_id -> { client, project, worker name }
  const [clientMap, setClientMap] = useState({});   // client_id -> name
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [filterClient, setFilterClient] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data: rows, error } = await supabase.from('timesheet_sends')
      .select('*').order('created_at', { ascending: false }).limit(500);
    if (error) { showToast(error.message, 'error'); setLoading(false); return; }
    const list = rows || [];
    setSends(list);

    // Two follow-up lookups instead of embeds: no dependency on FK naming.
    const headerIds = [...new Set(list.map(r => r.header_id).filter(Boolean))];
    const clientIds = [...new Set(list.map(r => r.client_id).filter(Boolean))];
    const [h, c] = await Promise.all([
      headerIds.length
        ? supabase.from('timesheet_headers').select('id, client, project, workers(name)').in('id', headerIds)
        : Promise.resolve({ data: [] }),
      clientIds.length
        ? supabase.from('clients').select('id, name').in('id', clientIds)
        : Promise.resolve({ data: [] }),
    ]);
    const hm = {};
    (h.data || []).forEach(r => { hm[r.id] = { client: r.client, project: r.project, worker: r.workers?.name }; });
    setHeaderMap(hm);
    const cm = {};
    (c.data || []).forEach(r => { cm[r.id] = r.name; });
    setClientMap(cm);
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const clientName = (row) => clientMap[row.client_id] || headerMap[row.header_id]?.client || '—';
  const workerName = (row) => headerMap[row.header_id]?.worker || '';

  const filtered = sends.filter(row => {
    const q = filterClient.trim().toLowerCase();
    const matchClient = !q
      || clientName(row).toLowerCase().includes(q)
      || workerName(row).toLowerCase().includes(q)
      || (row.subject || '').toLowerCase().includes(q);
    const matchStatus = !filterStatus || row.status === filterStatus;
    const day = (row.created_at || '').slice(0, 10);
    const matchRange = (!from || day >= from) && (!to || day <= to);
    return matchClient && matchStatus && matchRange;
  });

  const openPdf = async (row) => {
    if (!row.pdf_path) { showToast('No stored PDF on this row (a pre-ledger or failed-before-build send).', 'info'); return; }
    const { data, error } = await supabase.storage.from('timesheet-pdfs').createSignedUrl(row.pdf_path, 3600);
    if (error || !data?.signedUrl) {
      showToast(error?.message || 'Could not sign a URL — the storage read policy for timesheet-pdfs may not be applied yet.', 'error');
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const resend = async (row) => {
    if (!row.header_id) { showToast('This row has no linked timesheet to resend.', 'error'); return; }
    if (!window.confirm(`Resend this timesheet PDF${clientName(row) !== '—' ? ` to ${clientName(row)}` : ''}? A new ledger row is created for the new attempt.`)) return;
    setBusyId(row.id);
    const { data, error } = await supabase.functions.invoke('send-timesheet-pdf', {
      body: { header_id: row.header_id, force: true },
    });
    let msg = data?.error || error?.message;
    if (error?.context) {
      try { const j = await error.context.json(); msg = j.error || msg; } catch { /* keep msg */ }
    }
    setBusyId(null);
    if (error || data?.error) showToast(msg || 'Resend failed', 'error');
    else { showToast(`Resent via ${data?.via || 'email'}`, 'success'); load(); }
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        📤 <strong style={{ color: C.text }}>Sent Timesheets</strong> — every client-PDF email attempt, newest first.
        <strong style={{ color: C.text }}> Open PDF</strong> shows the exact file the client received (not a rebuild);
        <strong style={{ color: C.text }}> Resend</strong> sends it again and logs a new row. Hours only — no rates ever leave the portal.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input style={{ ...inputStyle, maxWidth: 240 }} placeholder="Filter client, worker, subject…"
          value={filterClient} onChange={e => setFilterClient(e.target.value)} />
        <select style={{ ...inputStyle, maxWidth: 150 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
        </select>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input style={{ ...inputStyle, maxWidth: 150 }} type="date" value={from} onChange={e => setFrom(e.target.value)} title="From date" />
          <span style={{ color: C.textMuted, fontSize: 12 }}>→</span>
          <input style={{ ...inputStyle, maxWidth: 150 }} type="date" value={to} onChange={e => setTo(e.target.value)} title="To date" />
        </div>
        {(filterClient || filterStatus || from || to) && (
          <button style={btnSmall} onClick={() => { setFilterClient(''); setFilterStatus(''); setFrom(''); setTo(''); }}>Clear</button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
          {filtered.length} of {sends.length} send{sends.length === 1 ? '' : 's'}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="No timesheet sends match — PDFs land here as timesheets are approved." icon="📤" />
      ) : (
        <TableWrap>
          <thead><tr><Th>Date</Th><Th>Client</Th><Th>Worker / Subject</Th><Th>To</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(row => (
              <tr key={row.id}>
                <Td>
                  <span style={{ fontFamily: '"DM Mono", monospace', fontSize: 12 }}>{fmtStamp(row.sent_at || row.created_at)}</span>
                </Td>
                <Td>{clientName(row)}</Td>
                <Td>
                  {workerName(row) && <div style={{ fontWeight: 700 }}>{workerName(row)}</div>}
                  <div style={{ fontSize: 11.5, color: C.textMuted, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.subject}>
                    {row.subject || '—'}
                  </div>
                </Td>
                <Td>
                  <div style={{ fontSize: 12 }}>{(row.to_emails || []).join(', ') || '—'}</div>
                  {(row.cc_emails || []).length > 0 && (
                    <div style={{ fontSize: 11, color: C.textMuted }}>cc: {(row.cc_emails || []).join(', ')}</div>
                  )}
                </Td>
                <Td>
                  {statusChip(row.status)}
                  {row.provider && <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 3, fontFamily: '"DM Mono", monospace' }}>via {row.provider}</div>}
                  {row.error && (
                    <div style={{ fontSize: 11, color: '#f87171', marginTop: 3, maxWidth: 260 }} title={row.error}>
                      {String(row.error).slice(0, 90)}{String(row.error).length > 90 ? '…' : ''}
                    </div>
                  )}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }} onClick={() => openPdf(row)} disabled={!row.pdf_path}>
                      Open PDF
                    </button>
                    <button style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }} onClick={() => resend(row)} disabled={busyId === row.id || !row.header_id}>
                      {busyId === row.id ? 'Sending…' : '↻ Resend'}
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
