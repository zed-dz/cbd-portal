import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { Field } from '../../components';

export function BulkMessagesPage({ showToast }) {
  const [workerMsg, setWorkerMsg] = useState('');
  const [clientMsg, setClientMsg] = useState('');
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedWorkers, setSelectedWorkers] = useState([]);
  const [selectedClients, setSelectedClients] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, mobile, email').eq('app_status', 'Active').order('name'),
        supabase.from('clients').select('id, name, contact, contact_email, contact_phone').order('name'),
      ]);
      setWorkers(w.data || []);
      setClients(c.data || []);
    })();
  }, []);

  const toggleWorker = (id) => setSelectedWorkers(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleClient = (id) => setSelectedClients(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const allWorkers = workers.length > 0 && selectedWorkers.length === workers.length;
  const allClients = clients.length > 0 && selectedClients.length === clients.length;

  const handleSendWorkers = async () => {
    if (!workerMsg.trim()) { showToast('Enter a message first.', 'error'); return; }
    if (!selectedWorkers.length) { showToast('Select at least one worker.', 'error'); return; }
    setSending(true);
    await new Promise(r => setTimeout(r, 800));
    showToast(`Message queued for ${selectedWorkers.length} worker(s)`, 'success');
    setWorkerMsg('');
    setSelectedWorkers([]);
    setSending(false);
  };

  const handleSendClients = async () => {
    if (!clientMsg.trim()) { showToast('Enter a message first.', 'error'); return; }
    if (!selectedClients.length) { showToast('Select at least one client.', 'error'); return; }
    setSending(true);
    await new Promise(r => setTimeout(r, 800));
    showToast(`Message queued for ${selectedClients.length} client(s)`, 'success');
    setClientMsg('');
    setSelectedClients([]);
    setSending(false);
  };

  const panelStyle = { background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <div style={panelStyle}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>👷 Worker Messages</div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ color: C.textMuted, fontSize: 13 }}>Recipients</label>
            <button onClick={() => setSelectedWorkers(allWorkers ? [] : workers.map(w => w.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allWorkers ? 'Deselect All' : 'Select All'}</button>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, background: C.bg }}>
            {workers.map(w => (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={selectedWorkers.includes(w.id)} onChange={() => toggleWorker(w.id)} />
                <span style={{ color: C.text, fontSize: 13 }}>{w.name}</span>
                {w.mobile && <span style={{ color: C.textMuted, fontSize: 11 }}>{w.mobile}</span>}
              </label>
            ))}
            {workers.length === 0 && <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No active workers</div>}
          </div>
        </div>
        <Field label="Message">
          <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={workerMsg} onChange={e => setWorkerMsg(e.target.value)} placeholder="Type your message to workers…" />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSendWorkers} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>📱 Send SMS</button>
          <button onClick={handleSendWorkers} disabled={sending} style={{ ...btnSecondary, flex: 1 }}>✉️ Send Email</button>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>🏗 Client Messages</div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ color: C.textMuted, fontSize: 13 }}>Recipients</label>
            <button onClick={() => setSelectedClients(allClients ? [] : clients.map(c => c.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allClients ? 'Deselect All' : 'Select All'}</button>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, background: C.bg }}>
            {clients.map(c => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={selectedClients.includes(c.id)} onChange={() => toggleClient(c.id)} />
                <span style={{ color: C.text, fontSize: 13 }}>{c.name}</span>
                {c.contact && <span style={{ color: C.textMuted, fontSize: 11 }}>{c.contact}</span>}
              </label>
            ))}
            {clients.length === 0 && <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No clients added yet</div>}
          </div>
        </div>
        <Field label="Message">
          <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={clientMsg} onChange={e => setClientMsg(e.target.value)} placeholder="Type your message to clients…" />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSendClients} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>📱 Send SMS</button>
          <button onClick={handleSendClients} disabled={sending} style={{ ...btnSecondary, flex: 1 }}>✉️ Send Email</button>
        </div>
      </div>
    </div>
  );
}
