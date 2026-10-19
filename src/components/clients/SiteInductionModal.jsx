import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';
import { Field, Spinner, TableWrap, Th, Td, Badge } from '../index';
import { Modal } from '../ui/Modal';

// Per-site induction / SWMS text — office side (2026-10-19). Opened from the
// "Induction" button on a site in ClientSitesManager. One live induction per
// site (older ones are archived, never deleted). Saving with "publish as a new
// version" bumps the version so every worker signs again; a plain save keeps
// the version (typo fix). The signatures table below shows who signed what.

export function SiteInductionModal({ site, client, onClose, showToast, currentWorker }) {
  const [ind, setInd] = useState(null);          // live induction row or null
  const [sigs, setSigs] = useState([]);
  const [workers, setWorkers] = useState({});
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ title: '', content: '', required: true, bump: false });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: rows } = await supabase.from('site_inductions').select('*').eq('site_id', site.id).is('archived_at', null).order('created_at', { ascending: false }).limit(1);
    const live = rows?.[0] || null;
    setInd(live);
    setF({ title: live?.title || `${site.name} — site induction`, content: live?.content || '', required: live ? live.required !== false : true, bump: false });
    if (live) {
      const [{ data: s }, { data: w }] = await Promise.all([
        supabase.from('site_induction_signatures').select('*').eq('induction_id', live.id).order('signed_at', { ascending: false }),
        supabase.from('workers').select('id, name'),
      ]);
      setSigs(s || []); setWorkers(Object.fromEntries((w || []).map(x => [x.id, x.name])));
    } else { setSigs([]); }
    setLoading(false);
  }, [site.id, site.name]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!f.title.trim()) { showToast('Give the induction a title.', 'error'); return; }
    if (!f.content.trim()) { showToast('Write the induction text.', 'error'); return; }
    setSaving(true);
    const payload = { title: f.title.trim(), content: f.content, required: !!f.required, created_by: currentWorker?.name || null };
    let error;
    if (ind) {
      if (f.bump) payload.version = (ind.version || 1) + 1;
      ({ error } = await supabase.from('site_inductions').update(payload).eq('id', ind.id));
    } else {
      ({ error } = await supabase.from('site_inductions').insert([{ ...payload, site_id: site.id }]));
    }
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: ind ? (f.bump ? 'republished' : 'updated') : 'created', object_type: 'site_induction', object_id: ind?.id || null,
      client_id: client?.id || null, site_id: site.id, after: { name: `${site.name}: ${payload.title}`, required: payload.required, version: payload.version || ind?.version || 1 } });
    showToast(ind ? (f.bump ? 'New version published — workers sign again.' : 'Induction updated.') : 'Induction created.', 'success');
    load();
  };

  const archive = async () => {
    if (!ind || !window.confirm('Archive this induction? Workers stop being asked; signatures are kept.')) return;
    const { error } = await supabase.from('site_inductions').update({ archived_at: new Date().toISOString() }).eq('id', ind.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'archived', object_type: 'site_induction', object_id: ind.id, site_id: site.id, after: { name: `${site.name}: ${ind.title}` } });
    showToast('Archived.', 'success'); load();
  };

  return (
    <Modal title={`Induction — ${site.name}`} onClose={onClose} width={720}>
      {loading ? <Spinner /> : (
        <>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginBottom: 12 }}>
            Workers with an accepted allocation at this site see a banner until they have read and signed the current version{ind ? ` (now v${ind.version})` : ''}.
          </div>
          <Field label="Title *"><input style={inputStyle} value={f.title} onChange={e => setF(s => ({ ...s, title: e.target.value }))} /></Field>
          <Field label="Induction / SWMS text *" hint="Plain text. Blank lines and numbered steps read fine on a phone.">
            <textarea style={{ ...inputStyle, minHeight: 220, resize: 'vertical', fontFamily: 'inherit' }} value={f.content} onChange={e => setF(s => ({ ...s, content: e.target.value }))}
              placeholder={'1. Sign in at the site office.\n2. PPE: hard hat, hi-vis, boots, glasses.\n3. Exclusion zones: …'} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, marginBottom: 8, minHeight: 32 }}>
            <input type="checkbox" checked={f.required} onChange={e => setF(s => ({ ...s, required: e.target.checked }))} style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Required — workers must sign before (or on) their first day here
          </label>
          {ind && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, marginBottom: 12, minHeight: 32 }}>
              <input type="checkbox" checked={f.bump} onChange={e => setF(s => ({ ...s, bump: e.target.checked }))} style={{ accentColor: C.accent, width: 16, height: 16 }} />
              Publish as version {ind.version + 1} — everyone signs again (leave off for a typo fix)
            </label>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>{ind && <button onClick={archive} style={btnSmall}>Archive</button>}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose} style={btnSecondary}>Close</button>
              <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : ind ? 'Save' : 'Create'}</button>
            </div>
          </div>

          {ind && (
            <>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Signed ({sigs.length})</div>
              {sigs.length === 0 ? <div style={{ color: C.textDim, fontSize: 12.5 }}>Nobody has signed yet.</div> : (
                <TableWrap>
                  <thead><tr><Th>Worker</Th><Th>Signed as</Th><Th>Version</Th><Th>When</Th></tr></thead>
                  <tbody>
                    {sigs.map(s => (
                      <tr key={s.id}>
                        <Td>{workers[s.worker_id] || '—'}</Td>
                        <Td>{s.signed_name}</Td>
                        <Td>{s.version === ind.version ? <Badge label={`v${s.version}`} color="green" /> : <Badge label={`v${s.version} (old)`} color="gray" />}</Td>
                        <Td>{fmtDateTime(s.signed_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
