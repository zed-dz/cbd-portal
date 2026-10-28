import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { Modal, Field, Spinner, EmptyState } from '../index';
import { isLikelyMapLink } from '../../utils/mapLink';
import { SiteInductionModal } from './SiteInductionModal';

// Sites and their contacts for ONE client.
//
// A client used to BE a site — running two jobs for the same company meant
// creating the company twice, which is why "Matt Civil" appeared three times in
// the allocation picker with three different rate cards. Sites now live here, and
// each site carries its own contacts: the supervisor who signs off hours is
// usually not the person accounts emails.
//
// `approves_timesheets` marks who receives the timesheet approval link for work
// on that site. Kept separate from `is_primary` deliberately.

const blankSite    = { name: '', address: '', notes: '', map_link: '', po_number: '', timesheet_emails_text: '', is_active: true };
const blankContact = { name: '', role: '', email: '', phone: '', is_primary: false, approves_timesheets: false };

export function ClientSitesManager({ client, onClose, showToast, currentWorker }) {
  const [sites, setSites]       = useState([]);
  const [inductionSite, setInductionSite] = useState(null); // site whose induction modal is open
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [siteForm, setSiteForm] = useState(null);      // {…site, id?}
  const [contactForm, setContactForm] = useState(null); // {…contact, site_id, id?}
  const [saving, setSaving]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: s, error } = await supabase
      .from('v_client_sites_office').select('*').eq('client_id', client.id).order('name');
    if (error) showToast(error.message, 'error');
    const siteIds = (s || []).map(x => x.id);
    let k = [];
    if (siteIds.length) {
      const res = await supabase.from('client_site_contacts').select('*').in('site_id', siteIds).order('name');
      k = res.data || [];
    }
    setSites(s || []); setContacts(k); setLoading(false);
  }, [client.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const saveSite = async () => {
    if (!siteForm.name.trim()) { showToast('Site name is required.', 'error'); return; }
    setSaving(true);
    const payload = {
      client_id: client.id,
      name: siteForm.name.trim(),
      address: siteForm.address || null,
      notes: siteForm.notes || null,
      map_link: siteForm.map_link || null,
      po_number: (siteForm.po_number || '').trim() || null,
      timesheet_emails: String(siteForm.timesheet_emails_text || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)),
      is_active: siteForm.is_active !== false,
    };
    const { error } = siteForm.id
      ? await supabase.from('client_sites').update(payload).eq('id', siteForm.id)
      : await supabase.from('client_sites').insert([payload]);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(siteForm.id ? 'Site updated.' : 'Site added.', 'success');
    setSiteForm(null); load();
  };

  // Sites are master data: deactivate, never delete (audit P1 / Dashpivot rule).
  // An inactive site leaves the pick-lists; old allocations keep it.
  const toggleSiteActive = async (site) => {
    const deactivating = site.is_active !== false;
    if (deactivating && !window.confirm(`Deactivate "${site.name}"?\n\nIt leaves the pick-lists. Allocations already recorded against it are unchanged, and you can reactivate it any time.`)) return;
    const { error } = await supabase.from('client_sites').update({ is_active: !deactivating }).eq('id', site.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(deactivating ? 'Site deactivated.' : 'Site reactivated.', 'success'); load();
  };

  const saveContact = async () => {
    if (!contactForm.name.trim()) { showToast('Contact name is required.', 'error'); return; }
    setSaving(true);
    const payload = {
      site_id: contactForm.site_id,
      name: contactForm.name.trim(),
      role: contactForm.role || null,
      email: contactForm.email || null,
      phone: contactForm.phone || null,
      is_primary: !!contactForm.is_primary,
      approves_timesheets: !!contactForm.approves_timesheets,
    };
    const { error } = contactForm.id
      ? await supabase.from('client_site_contacts').update(payload).eq('id', contactForm.id)
      : await supabase.from('client_site_contacts').insert([payload]);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(contactForm.id ? 'Contact updated.' : 'Contact added.', 'success');
    setContactForm(null); load();
  };

  const removeContact = async (c) => {
    // eslint-disable-next-line no-restricted-globals
    if (!window.confirm(`Remove ${c.name} from this site?`)) return;
    const { error } = await supabase.from('client_site_contacts').delete().eq('id', c.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Contact removed.', 'success'); load();
  };

  return (
    <Modal title={`Sites — ${client.name}`} onClose={onClose} width={760}>
      <div style={{ marginBottom: 12, fontSize: 12, color: C.textMuted }}>
        One row per job site or project for this client. Each site can hold as many contacts as you
        need — a site supervisor, a foreman, an accounts person. Tick <strong>Approves timesheets</strong>
        on whoever should receive the approval link for work on that site.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button style={btnPrimary} onClick={() => setSiteForm({ ...blankSite })}>+ Add site</button>
      </div>

      {loading ? <Spinner /> : sites.length === 0 ? (
        <EmptyState message="No sites yet. Add the first job site for this client." icon="🏗" />
      ) : sites.map(site => {
        const mine = contacts.filter(c => c.site_id === site.id);
        return (
          <div key={site.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 10, background: C.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {site.name}
                  {site.is_active === false && <span style={{ marginLeft: 8, fontSize: 10, color: C.textMuted }}>(inactive)</span>}
                </div>
                {site.address && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{site.address}</div>}
                {site.map_link && <a href={site.map_link} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#93c5fd', textDecoration: 'none' }}>📍 Map pin</a>}
                {site.po_number && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>PO {site.po_number}</div>}
                {site.notes && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{site.notes}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button style={btnSmall} onClick={() => setSiteForm({ ...site, timesheet_emails_text: (site.timesheet_emails || []).join(', ') })}>Edit</button>
                <button style={btnSmall} onClick={() => setInductionSite(site)} title="Site induction / SWMS the crew must read and sign">🦺 Induction</button>
                <button style={btnSmall} onClick={() => toggleSiteActive(site)}>{site.is_active === false ? 'Reactivate' : 'Deactivate'}</button>
              </div>
            </div>

            <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              {mine.length === 0
                ? <div style={{ fontSize: 12, color: C.textMuted }}>No contacts on this site yet.</div>
                : mine.map(c => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                    <div style={{ fontSize: 12 }}>
                      <strong>{c.name}</strong>
                      {c.role && <span style={{ color: C.textMuted }}> · {c.role}</span>}
                      {c.email && <span style={{ color: C.textMuted }}> · {c.email}</span>}
                      {c.phone && <span style={{ color: C.textMuted }}> · {c.phone}</span>}
                      {c.is_primary && <span style={{ marginLeft: 6, color: C.accent, fontSize: 10 }}>PRIMARY</span>}
                      {c.approves_timesheets && <span style={{ marginLeft: 6, color: C.success, fontSize: 10 }}>APPROVES TIMESHEETS</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button style={btnSmall} onClick={() => setContactForm({ ...c })}>Edit</button>
                      <button style={{ ...btnSmall, ...btnDanger }} onClick={() => removeContact(c)}>✕</button>
                    </div>
                  </div>
                ))}
              <button style={{ ...btnSecondary, marginTop: 6 }} onClick={() => setContactForm({ ...blankContact, site_id: site.id })}>
                + Add contact
              </button>
            </div>
          </div>
        );
      })}

      {siteForm && (
        <Modal title={siteForm.id ? 'Edit site' : 'Add site'} onClose={() => setSiteForm(null)}>
          <Field label="Site / project name *">
            <input style={inputStyle} value={siteForm.name} autoFocus
              onChange={e => setSiteForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Jordan Springs" />
          </Field>
          <Field label="Address">
            <input style={inputStyle} value={siteForm.address || ''}
              onChange={e => setSiteForm(f => ({ ...f, address: e.target.value }))}
              placeholder="Street, Suburb, State" />
          </Field>
          <Field label="Map link (pin drop)" hint="Paste the maps link the client texted — allocations for this site pick it up automatically.">
            <input style={inputStyle} value={siteForm.map_link || ''}
              onChange={e => setSiteForm(f => ({ ...f, map_link: e.target.value }))}
              placeholder="https://maps.app.goo.gl/…" />
            {siteForm.map_link && !isLikelyMapLink(siteForm.map_link) && (
              <div style={{ fontSize: 11, color: C.warning, marginTop: 4 }}>
                ⚠ Doesn't look like a Google/Apple Maps link — it will still save, but check it opens a map.
              </div>
            )}
          </Field>
          <Field label="Purchase order (PO) number" hint="Goes on every timesheet email and PDF for this site, so the client can match it.">
            <input style={inputStyle} value={siteForm.po_number || ''} maxLength={60}
              onChange={e => setSiteForm(f => ({ ...f, po_number: e.target.value }))}
              placeholder="e.g. PO-45821" />
          </Field>
          <Field label="Send approved timesheets to (this site only)" hint="Leave empty to use the client's list.">
            <input style={inputStyle} value={siteForm.timesheet_emails_text || ''}
              onChange={e => setSiteForm(f => ({ ...f, timesheet_emails_text: e.target.value }))}
              placeholder="engineer@client.com.au" />
          </Field>
          <Field label="Notes">
            <input style={inputStyle} value={siteForm.notes || ''}
              onChange={e => setSiteForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Access, inductions, parking…" />
          </Field>
          <Field label="Active">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={siteForm.is_active !== false}
                onChange={e => setSiteForm(f => ({ ...f, is_active: e.target.checked }))}
                style={{ accentColor: C.accent, width: 16, height: 16 }} />
              Show this site when allocating
            </label>
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button style={btnSecondary} onClick={() => setSiteForm(null)}>Cancel</button>
            <button style={btnPrimary} onClick={saveSite} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {inductionSite && (
        <SiteInductionModal site={inductionSite} client={client} currentWorker={currentWorker} showToast={showToast} onClose={() => setInductionSite(null)} />
      )}

      {contactForm && (
        <Modal title={contactForm.id ? 'Edit contact' : 'Add contact'} onClose={() => setContactForm(null)}>
          <Field label="Name *">
            <input style={inputStyle} value={contactForm.name} autoFocus
              onChange={e => setContactForm(f => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label="Role">
            <input style={inputStyle} value={contactForm.role || ''}
              onChange={e => setContactForm(f => ({ ...f, role: e.target.value }))}
              placeholder="e.g. Site Supervisor, Foreman, Accounts" />
          </Field>
          <Field label="Email">
            <input style={inputStyle} type="email" value={contactForm.email || ''}
              onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))} />
          </Field>
          <Field label="Phone">
            <input style={inputStyle} type="tel" value={contactForm.phone || ''}
              onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={!!contactForm.is_primary}
              onChange={e => setContactForm(f => ({ ...f, is_primary: e.target.checked }))}
              style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Primary contact for this site
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
            <input type="checkbox" checked={!!contactForm.approves_timesheets}
              onChange={e => setContactForm(f => ({ ...f, approves_timesheets: e.target.checked }))}
              style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Approves timesheets — receives the approval link for this site
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button style={btnSecondary} onClick={() => setContactForm(null)}>Cancel</button>
            <button style={btnPrimary} onClick={saveContact} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
