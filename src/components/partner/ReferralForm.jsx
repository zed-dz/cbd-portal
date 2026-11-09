// Refer work — the < 3 minute guided form (spec 3.2). Phone first: one column,
// big tap targets, chips for roles, inline errors. Attachment goes to the
// private partner-referrals bucket under the partner's own folder.
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Field, DateField } from '../index';
import { REFERRAL_TYPES, SOURCE_OPTIONS, validateReferral } from '../../utils/commission';
import { useDraft } from '../../utils/useDraft';

const BUCKET = 'partner-referrals';
const blank = () => ({
  referral_type: '', company_name: '', contact_name: '', contact_phone: '', contact_email: '',
  site_address: '', map_link: '', roles: [], roles_other: '', people_count: 1, start_date: '', duration_text: '',
  shift_pattern: '', special_requirements: '', source: '', partner_notes: '',
});

const chip = (on) => ({
  ...btnSmall, borderRadius: R.pill, padding: '7px 12px', minHeight: 34,
  background: on ? C.accentSoft : C.cardHover, borderColor: on ? C.accentBorder : C.border, color: on ? C.text : C.textMuted, fontWeight: on ? 600 : 500,
});
const seg = (on) => ({
  flex: 1, minWidth: 0, padding: '10px 6px', borderRadius: R.md, border: `1px solid ${on ? C.accentBorder : C.border}`,
  background: on ? C.accentSoft : C.bg, color: on ? C.text : C.textMuted, fontSize: 12, fontWeight: on ? 600 : 500, cursor: 'pointer', lineHeight: 1.2,
});

export function ReferralForm({ partner, showToast, onSubmitted }) {
  const [f, setF, { clear }] = useDraft(`partner-referral-${partner.id}`, blank());
  const [errors, setErrors] = useState({});
  const [lookup, setLookup] = useState({ clients: [], roles: [] });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    supabase.rpc('partner_lookup').then(({ data }) => { if (data) setLookup({ clients: data.clients || [], roles: data.roles || [] }); });
  }, []);

  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const toggleRole = (name) => set('roles', (f.roles || []).includes(name) ? f.roles.filter(r => r !== name) : [...(f.roles || []), name]);

  const suggestions = useMemo(() => {
    const q = String(f.company_name || '').trim().toLowerCase();
    if (q.length < 2) return [];
    return lookup.clients.filter(c => c.name.toLowerCase().includes(q) && c.name.toLowerCase() !== q).slice(0, 5);
  }, [f.company_name, lookup.clients]);

  async function submit(e) {
    e.preventDefault();
    const errs = validateReferral(f);
    setErrors(errs);
    if (Object.keys(errs).length) { showToast('Fix the highlighted fields.', 'error'); return; }
    setBusy(true);
    try {
      let attachment_path = null;
      if (file) {
        const safe = file.name.replace(/[^\w.-]+/g, '_').slice(0, 80);
        attachment_path = `${partner.id}/${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(attachment_path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (upErr) throw new Error(`Attachment failed: ${upErr.message}`);
      }
      const row = {
        partner_id: partner.id,
        referral_type: f.referral_type,
        company_name: f.company_name.trim(),
        contact_name: f.contact_name.trim(),
        contact_phone: f.contact_phone.trim() || null,
        contact_email: f.contact_email.trim() || null,
        site_address: f.site_address.trim(),
        map_link: f.map_link.trim() || null,
        roles: (f.roles || []).filter(Boolean),
        roles_other: f.roles_other.trim() || null,
        people_count: parseInt(f.people_count, 10) || 1,
        start_date: f.start_date,
        duration_text: f.duration_text.trim(),
        shift_pattern: f.shift_pattern.trim() || null,
        special_requirements: f.special_requirements.trim() || null,
        source: f.source || null,
        partner_notes: f.partner_notes.trim() || null,
        attachment_path,
        status: 'submitted',
        is_test: /\(test\)/i.test(partner.name || ''),
      };
      const { data, error } = await supabase.from('partner_referrals').insert([row]).select('id, company_name').single();
      if (error) throw error;
      // Confirmation e-mail / SMS to the partner + the office bell. Fire-and-forget.
      supabase.functions.invoke('notify-partner', { body: { partner_id: partner.id, kind: 'referral_received', referral_id: data.id } }).catch(() => {});
      clear();
      setFile(null);
      setDone(data);
      onSubmitted?.(data);
    } catch (err) {
      showToast(err.message || 'Could not submit.', 'error');
    }
    setBusy(false);
  }

  if (done) {
    return (
      <div data-area="referral confirmation" style={{ background: C.card, border: `1px solid ${C.successSoft}`, borderRadius: R.lg, padding: 22, textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: 8 }}>Referral sent</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6 }}>{done.company_name} is in your list as <strong style={{ color: C.text }}>Submitted</strong>. You will get an email when the status changes.</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
          <button style={btnPrimary} onClick={() => { setDone(null); setF(blank()); }}>Refer another</button>
          <button style={btnSecondary} onClick={() => onSubmitted?.(done, 'view')}>View my referrals</button>
        </div>
      </div>
    );
  }

  const ta = { ...inputStyle, minHeight: 64, resize: 'vertical' };

  return (
    <form onSubmit={submit} data-area="referral form" noValidate>
      <Field label="Referral type *" error={errors.referral_type}>
        <div style={{ display: 'flex', gap: 6 }}>
          {REFERRAL_TYPES.map(t => <button type="button" key={t.id} onClick={() => set('referral_type', t.id)} style={seg(f.referral_type === t.id)}>{t.label}</button>)}
        </div>
      </Field>

      <Field label="Client / company name *" error={errors.company_name}>
        <input style={inputStyle} value={f.company_name} onChange={e => set('company_name', e.target.value)} placeholder="Company" autoComplete="organization" />
        {suggestions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {suggestions.map(c => <button type="button" key={c.id} style={chip(false)} onClick={() => set('company_name', c.name)}>{c.name}</button>)}
          </div>
        )}
      </Field>

      <Field label="Contact name *" error={errors.contact_name}>
        <input style={inputStyle} value={f.contact_name} onChange={e => set('contact_name', e.target.value)} placeholder="Who to call" autoComplete="name" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Field label="Phone *" error={errors.contact_phone}>
          <input style={inputStyle} value={f.contact_phone} onChange={e => set('contact_phone', e.target.value)} placeholder="04xx xxx xxx" inputMode="tel" />
        </Field>
        <Field label="Email" error={errors.contact_email}>
          <input style={inputStyle} value={f.contact_email} onChange={e => set('contact_email', e.target.value)} placeholder="name@company.com" inputMode="email" />
        </Field>
      </div>

      <Field label="Site location / address *" error={errors.site_address}>
        <input style={inputStyle} value={f.site_address} onChange={e => set('site_address', e.target.value)} placeholder="Street, suburb" autoComplete="street-address" />
      </Field>
      <Field label="Map link" error={errors.map_link}>
        <input style={inputStyle} value={f.map_link} onChange={e => set('map_link', e.target.value)} placeholder="https://maps.app.goo.gl/…" inputMode="url" />
      </Field>

      <Field label="Roles / skills required *" error={errors.roles}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {lookup.roles.map(name => <button type="button" key={name} onClick={() => toggleRole(name)} style={chip((f.roles || []).includes(name))}>{name}</button>)}
        </div>
        <input style={inputStyle} value={f.roles_other} onChange={e => set('roles_other', e.target.value)} placeholder="Other role or skill" />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Field label="Number of people *" error={errors.people_count}>
          <input style={inputStyle} type="number" min={1} value={f.people_count} onChange={e => set('people_count', e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Start date *" error={errors.start_date}>
          <DateField value={f.start_date} onChange={v => set('start_date', v)} />
        </Field>
      </div>
      <Field label="Expected duration *" error={errors.duration_text}>
        <input style={inputStyle} value={f.duration_text} onChange={e => set('duration_text', e.target.value)} placeholder="e.g. 6 weeks, ongoing" />
      </Field>
      <Field label="Shift pattern / hours">
        <input style={inputStyle} value={f.shift_pattern} onChange={e => set('shift_pattern', e.target.value)} placeholder="e.g. Mon–Fri 6am–4pm, night shift" />
      </Field>
      <Field label="Special requirements / tickets">
        <textarea style={ta} value={f.special_requirements} onChange={e => set('special_requirements', e.target.value)} placeholder="White card, RIW, HR licence…" />
      </Field>
      <Field label="How did you source this?">
        <div style={{ display: 'flex', gap: 6 }}>
          {SOURCE_OPTIONS.map(s => <button type="button" key={s.id} onClick={() => set('source', s.id)} style={seg(f.source === s.id)}>{s.label}</button>)}
        </div>
      </Field>
      <Field label="Your notes / rate context">
        <textarea style={ta} value={f.partner_notes} onChange={e => set('partner_notes', e.target.value)} placeholder="Anything the office should know" />
      </Field>
      <Field label="Attachment (optional)" hint="PDF, image or document · 10 MB max">
        <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx" onChange={e => setFile(e.target.files?.[0] || null)} style={{ display: 'none' }} data-testid="referral-attachment" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={btnSecondary} onClick={() => fileRef.current?.click()}>📎 {file ? 'Change file' : 'Add file'}</button>
          {file && <span style={{ fontSize: 12, color: C.textMuted, wordBreak: 'break-all' }}>{file.name}</span>}
          {file && <button type="button" style={btnSmall} onClick={() => setFile(null)}>Remove</button>}
        </div>
      </Field>

      <button type="submit" disabled={busy} style={{ ...btnPrimary, width: '100%', padding: '13px 18px', fontSize: 15, marginTop: 6 }}>
        {busy ? 'Sending…' : 'Submit referral'}
      </button>
    </form>
  );
}
