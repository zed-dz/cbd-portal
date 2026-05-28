import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { Spinner, Field } from '../../components';

// Multi-step worker onboarding. The worker arrives via /onboard/<token>
// (sent by an admin), fills six sections, hits Submit. The RPC writes
// non-sensitive fields to workers, sensitive fields to RLS-locked tables
// (worker_payroll_details, worker_medical_details), and an edge function
// then creates their Supabase auth user so they can log in to the worker
// portal.

const STEPS = [
  { id: 'personal',  label: 'About You' },
  { id: 'rights',    label: 'Work Rights' },
  { id: 'bank',      label: 'Bank' },
  { id: 'super',     label: 'Super' },
  { id: 'emergency', label: 'Emergency' },
  { id: 'medical',   label: 'Medical' },
  { id: 'review',    label: 'Review' },
];

const EMPTY = {
  // Personal & ID
  mobile: '', alternate_phone: '',
  address: '', postal_address: '', postal_same_as_address: true,
  date_of_birth: '', gender: '',
  drivers_licence_number: '', drivers_licence_expiry: '',
  licences: '',
  photo_url: '',
  // Working rights
  citizenship_status: 'citizen',
  visa_subclass: '', visa_expiry: '',
  claim_tax_free_threshold: true,
  has_hecs_debt: false,
  // Bank
  bank_account_name: '', bank_bsb: '', bank_account_number: '',
  // Super
  use_default_super: false,
  super_fund_name: '', super_fund_usi: '', super_member_number: '',
  // Tax
  tfn: '',
  // Emergency
  emergency_name: '', emergency_relationship: '', emergency_phone: '', emergency_phone_alt: '',
  // Medical
  blood_type: '', allergies: '', conditions: '', medications: '',
  gp_name: '', gp_phone: '', medicare_number: '',
};

export function OnboardProfilePage({ token }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [step, setStep]     = useState(0);
  const [form, setForm]     = useState(EMPTY);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.rpc('get_public_worker_profile', { token });
      if (!mounted) return;
      if (error) setError(error.message);
      else if (!data || data.length === 0) setError('Invite link is invalid or has expired.');
      else {
        const p = data[0];
        setProfile(p);
        setForm(f => ({ ...f, mobile: p.mobile || '', licences: p.licences || '' }));
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [token]);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    const blank = (v) => (v === '' || v == null) ? null : v;
    const params = {
      token,
      p_mobile:                   blank(form.mobile),
      p_alternate_phone:          blank(form.alternate_phone),
      p_address:                  blank(form.address),
      p_postal_address:           form.postal_same_as_address ? null : blank(form.postal_address),
      p_date_of_birth:            blank(form.date_of_birth),
      p_gender:                   blank(form.gender),
      p_drivers_licence_number:   blank(form.drivers_licence_number),
      p_drivers_licence_expiry:   blank(form.drivers_licence_expiry),
      p_citizenship_status:       blank(form.citizenship_status),
      p_visa_subclass:            form.citizenship_status === 'visa' ? blank(form.visa_subclass) : null,
      p_visa_expiry:              form.citizenship_status === 'visa' ? blank(form.visa_expiry)   : null,
      p_claim_tax_free_threshold: form.claim_tax_free_threshold,
      p_has_hecs_debt:            form.has_hecs_debt,
      p_emergency_name:           blank(form.emergency_name),
      p_emergency_relationship:   blank(form.emergency_relationship),
      p_emergency_phone:          blank(form.emergency_phone),
      p_emergency_phone_alt:      blank(form.emergency_phone_alt),
      p_licences:                 blank(form.licences),
      p_photo_url:                blank(form.photo_url),
      p_tfn:                      blank(form.tfn),
      p_bank_account_name:        blank(form.bank_account_name),
      p_bank_bsb:                 blank(form.bank_bsb),
      p_bank_account_number:      blank(form.bank_account_number),
      p_super_fund_name:          form.use_default_super ? null : blank(form.super_fund_name),
      p_super_fund_usi:           form.use_default_super ? null : blank(form.super_fund_usi),
      p_super_member_number:      form.use_default_super ? null : blank(form.super_member_number),
      p_use_default_super:        form.use_default_super,
      p_blood_type:               blank(form.blood_type),
      p_allergies:                blank(form.allergies),
      p_conditions:               blank(form.conditions),
      p_medications:              blank(form.medications),
      p_gp_name:                  blank(form.gp_name),
      p_gp_phone:                 blank(form.gp_phone),
      p_medicare_number:          blank(form.medicare_number),
    };

    const { data: rpcOk, error: rpcErr } = await supabase.rpc('update_worker_via_token', params);
    if (rpcErr || !rpcOk) {
      setError(rpcErr?.message || 'Could not save your details. The link may have expired.');
      setSaving(false);
      return;
    }

    // Fire-and-forget the auth invite. If it fails (SMTP not set, etc.) the
    // worker still has their profile saved; admin can resend manually.
    try {
      await supabase.functions.invoke('worker-finalize', { body: { token } });
    } catch {
      // Swallow — primary success is RPC. Don't block the worker.
    }

    setSaved(true);
    setSaving(false);
  };

  // ── Render gates ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <Spinner size={36} />
      </div>
    );
  }

  if (error && !profile) {
    return (
      <Centered>
        <div style={{ fontSize: 42, marginBottom: 12 }}>⚠️</div>
        <div style={{ color: C.text, fontSize: 19, fontWeight: 700, marginBottom: 6 }}>Link unavailable</div>
        <div style={{ color: C.textMuted, fontSize: 13, maxWidth: 360 }}>{error}</div>
      </Centered>
    );
  }

  if (saved) {
    return (
      <Centered>
        <div style={{ fontSize: 52, marginBottom: 14 }}>🎉</div>
        <div style={{ color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 8, fontFamily: 'Syne, sans-serif' }}>
          Thanks, {(profile.name || 'there').split(' ')[0]}!
        </div>
        <div style={{ color: C.textMuted, fontSize: 14, maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
          Your profile's saved. We'll review it shortly and send you a sign-in link
          to <strong style={{ color: C.text }}>{profile.email || 'your email'}</strong> so you can log into the worker portal,
          see your bookings and submit timesheets.
        </div>
      </Centered>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(249,115,22,0.10), transparent 65%), ${C.bg}`,
      padding: '24px 14px 64px',
    }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <Brand />

        <Stepper steps={STEPS} current={step} onPick={setStep} />

        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl,
          padding: '24px 22px 20px',
          boxShadow: '0 20px 48px -20px rgba(0,0,0,0.5)',
          marginTop: 14,
        }}>
          {step === 0 && <StepWelcome  profile={profile} />}
          {STEPS[step].id === 'personal'  && <StepPersonal  form={form} set={set} workerId={profile.id} />}
          {STEPS[step].id === 'rights'    && <StepRights    form={form} set={set} />}
          {STEPS[step].id === 'bank'      && <StepBank      form={form} set={set} />}
          {STEPS[step].id === 'super'     && <StepSuper     form={form} set={set} />}
          {STEPS[step].id === 'emergency' && <StepEmergency form={form} set={set} />}
          {STEPS[step].id === 'medical'   && <StepMedical   form={form} set={set} />}
          {STEPS[step].id === 'review'    && <StepReview    form={form} profile={profile} />}

          {error && (
            <div style={{
              marginTop: 14, padding: '8px 12px',
              background: 'rgba(244,63,94,0.10)', border: `1px solid rgba(244,63,94,0.4)`,
              borderRadius: 8, color: '#fda4af', fontSize: 12.5,
            }}>{error}</div>
          )}

          <Nav
            step={step}
            total={STEPS.length}
            onBack={() => setStep(s => Math.max(0, s - 1))}
            onNext={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
            onSubmit={handleSubmit}
            saving={saving}
          />
        </div>

        <div style={{
          marginTop: 18, textAlign: 'center',
          fontSize: 10.5, color: C.textDim, fontFamily: MONO, letterSpacing: 1.2,
        }}>
          CBD Plant & Labour · ABN 75 663 693 070 · TFN and bank details are encrypted in storage.
        </div>
      </div>
    </div>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function Brand() {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 28, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -0.5 }}>CBD</div>
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 2.5, textTransform: 'uppercase', marginTop: 4 }}>Plant & Labour · Onboarding</div>
    </div>
  );
}

function Stepper({ steps, current, onPick }) {
  return (
    <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((s, i) => {
        const active = i === current;
        const past   = i < current;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(i)}
            style={{
              flex: '0 0 auto',
              padding: '4px 9px',
              background: active ? C.accent : (past ? 'rgba(249,115,22,0.18)' : 'rgba(100,116,139,0.10)'),
              color: active ? '#fff' : (past ? C.accent : C.textMuted),
              border: 'none', borderRadius: 999,
              fontSize: 11, fontWeight: active ? 700 : 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
              fontFamily: MONO, letterSpacing: 0.4,
            }}
          >
            {i + 1}. {s.label}
          </button>
        );
      })}
    </div>
  );
}

function Nav({ step, total, onBack, onNext, onSubmit, saving }) {
  const isLast = step === total - 1;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18, gap: 8 }}>
      <button
        type="button"
        onClick={onBack}
        disabled={step === 0 || saving}
        style={{ ...btnSecondary, padding: '10px 18px', visibility: step === 0 ? 'hidden' : 'visible' }}
      >← Back</button>

      {isLast ? (
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          style={{ ...btnPrimary, padding: '11px 22px', fontWeight: 700, flex: 1 }}
        >
          {saving ? 'Submitting…' : 'Submit my profile  →'}
        </button>
      ) : (
        <button
          type="button"
          onClick={onNext}
          style={{ ...btnPrimary, padding: '10px 22px', fontWeight: 600 }}
        >Next →</button>
      )}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: C.bg, padding: 20, textAlign: 'center',
    }}>
      {children}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: C.text, fontFamily: 'Syne, sans-serif', letterSpacing: -0.3 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4, lineHeight: 1.55 }}>{subtitle}</div>}
    </div>
  );
}

// ── Steps ───────────────────────────────────────────────────────────────────

function StepWelcome({ profile }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ width: 36, height: 36, borderRadius: R.pill, background: 'rgba(249,115,22,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>👋</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: 'Syne, sans-serif', letterSpacing: -0.3 }}>
          Welcome, {(profile.name || 'there').split(' ')[0]}.
        </div>
      </div>
      <div style={{ fontSize: 13.5, color: C.textMuted, marginBottom: 12, lineHeight: 1.55 }}>
        We need a few details to put you on jobs and pay you correctly. The form's split into short sections — about 5 minutes total.
      </div>
      <ul style={{ paddingLeft: 18, fontSize: 13, color: C.textMuted, lineHeight: 1.7, margin: 0 }}>
        <li>Personal & ID (mobile, address, licence)</li>
        <li>Work rights (TFN, tax-free threshold, visa if applicable)</li>
        <li>Bank account</li>
        <li>Super fund</li>
        <li>Emergency contact</li>
        <li>Medical (allergies, GP, medications)</li>
      </ul>
      <div style={{ marginTop: 16, padding: '8px 12px', background: 'rgba(34,197,94,0.10)', border: `1px solid rgba(34,197,94,0.3)`, borderRadius: 8, fontSize: 12, color: C.success }}>
        🔒 Your TFN, bank and medical details are stored separately and only visible to authorised payroll admins. Other staff can't see them.
      </div>
    </>
  );
}

function StepPersonal({ form, set, workerId }) {
  return (
    <>
      <SectionHeader title="About you" subtitle="The basics. Keep your mobile current — we use it to text you about shifts." />
      <PhotoUploader workerId={workerId} value={form.photo_url} onChange={(url) => set({ photo_url: url })} />
      <Field label="Mobile *"><input style={inputStyle} type="tel" value={form.mobile} onChange={e => set({ mobile: e.target.value })} placeholder="04xx xxx xxx" /></Field>
      <Field label="Alternate phone (optional)"><input style={inputStyle} type="tel" value={form.alternate_phone} onChange={e => set({ alternate_phone: e.target.value })} /></Field>
      <Field label="Date of birth"><input style={inputStyle} type="date" value={form.date_of_birth} onChange={e => set({ date_of_birth: e.target.value })} /></Field>
      <Field label="Gender (optional)">
        <select style={inputStyle} value={form.gender} onChange={e => set({ gender: e.target.value })}>
          <option value="">—</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="non_binary">Non-binary</option>
          <option value="prefer_not">Prefer not to say</option>
        </select>
      </Field>
      <Field label="Residential address *"><input style={inputStyle} value={form.address} onChange={e => set({ address: e.target.value })} placeholder="Street, Suburb, State, Postcode" /></Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.textMuted, marginBottom: 10 }}>
        <input type="checkbox" checked={form.postal_same_as_address} onChange={e => set({ postal_same_as_address: e.target.checked })} />
        Postal address is the same
      </label>
      {!form.postal_same_as_address && (
        <Field label="Postal address"><input style={inputStyle} value={form.postal_address} onChange={e => set({ postal_address: e.target.value })} placeholder="PO Box / different address" /></Field>
      )}
      <Field label="Driver's licence number"><input style={inputStyle} value={form.drivers_licence_number} onChange={e => set({ drivers_licence_number: e.target.value })} /></Field>
      <Field label="Driver's licence expiry"><input style={inputStyle} type="date" value={form.drivers_licence_expiry} onChange={e => set({ drivers_licence_expiry: e.target.value })} /></Field>
      <Field label="Tickets / Licences" hint="Comma-separated. We'll record expiry dates with you on first day on site.">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} value={form.licences} onChange={e => set({ licences: e.target.value })} placeholder="e.g. White Card, EWP, VOC Excavator, RIW" />
      </Field>
    </>
  );
}

function StepRights({ form, set }) {
  return (
    <>
      <SectionHeader title="Work rights & tax" subtitle="So payroll deducts the right amount of tax." />
      <Field label="Australian work status *">
        <select style={inputStyle} value={form.citizenship_status} onChange={e => set({ citizenship_status: e.target.value })}>
          <option value="citizen">Australian citizen</option>
          <option value="permanent_resident">Permanent resident</option>
          <option value="visa">On a visa (working rights)</option>
          <option value="other">Other</option>
        </select>
      </Field>
      {form.citizenship_status === 'visa' && (
        <>
          <Field label="Visa subclass *" hint="e.g. 482, 417, 500.">
            <input style={inputStyle} value={form.visa_subclass} onChange={e => set({ visa_subclass: e.target.value })} placeholder="482" />
          </Field>
          <Field label="Visa expiry"><input style={inputStyle} type="date" value={form.visa_expiry} onChange={e => set({ visa_expiry: e.target.value })} /></Field>
        </>
      )}
      <Field label="Tax File Number (TFN)" hint="Stored encrypted. Only payroll admins can see it. If you don't have one yet, leave blank and admin will follow up.">
        <input style={inputStyle} inputMode="numeric" value={form.tfn} onChange={e => set({ tfn: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} placeholder="9 digits" />
      </Field>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: C.text, marginBottom: 10, lineHeight: 1.5 }}>
        <input type="checkbox" checked={form.claim_tax_free_threshold} onChange={e => set({ claim_tax_free_threshold: e.target.checked })} style={{ marginTop: 2 }} />
        <span><strong>Claim the tax-free threshold</strong> with CBD Plant & Labour. <span style={{ color: C.textMuted }}>Tick this if CBD is your main job. Only tick with one employer at a time.</span></span>
      </label>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
        <input type="checkbox" checked={form.has_hecs_debt} onChange={e => set({ has_hecs_debt: e.target.checked })} style={{ marginTop: 2 }} />
        <span>I have a <strong>HECS/HELP/STSL</strong> debt</span>
      </label>
    </>
  );
}

function StepBank({ form, set }) {
  return (
    <>
      <SectionHeader title="Bank account" subtitle="Where we deposit your pay." />
      <Field label="Account holder name *"><input style={inputStyle} value={form.bank_account_name} onChange={e => set({ bank_account_name: e.target.value })} placeholder="As shown on your bank statement" /></Field>
      <Field label="BSB *"><input style={inputStyle} inputMode="numeric" value={form.bank_bsb} onChange={e => set({ bank_bsb: e.target.value.replace(/[^0-9-]/g, '').slice(0, 7) })} placeholder="062-000" /></Field>
      <Field label="Account number *"><input style={inputStyle} inputMode="numeric" value={form.bank_account_number} onChange={e => set({ bank_account_number: e.target.value.replace(/[^0-9]/g, '').slice(0, 12) })} /></Field>
      <div style={{ padding: '8px 12px', background: 'rgba(56,189,248,0.08)', border: `1px solid rgba(56,189,248,0.3)`, borderRadius: 8, fontSize: 11.5, color: C.info, marginTop: 4 }}>
        🔒 Bank details are stored encrypted and visible only to authorised payroll admins.
      </div>
    </>
  );
}

function StepSuper({ form, set }) {
  return (
    <>
      <SectionHeader title="Superannuation" subtitle="Where we pay your super." />
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.5 }}>
        <input type="checkbox" checked={form.use_default_super} onChange={e => set({ use_default_super: e.target.checked })} style={{ marginTop: 2 }} />
        <span>Use <strong>CBD's default super fund</strong>. <span style={{ color: C.textMuted }}>Tick this and admin will set up the fund for you.</span></span>
      </label>
      {!form.use_default_super && (
        <>
          <Field label="Super fund name"><input style={inputStyle} value={form.super_fund_name} onChange={e => set({ super_fund_name: e.target.value })} placeholder="e.g. AustralianSuper" /></Field>
          <Field label="Fund USI" hint="Unique Superannuation Identifier — on your super statement.">
            <input style={inputStyle} value={form.super_fund_usi} onChange={e => set({ super_fund_usi: e.target.value })} placeholder="e.g. STA0100AU" />
          </Field>
          <Field label="Member number"><input style={inputStyle} value={form.super_member_number} onChange={e => set({ super_member_number: e.target.value })} /></Field>
        </>
      )}
    </>
  );
}

function StepEmergency({ form, set }) {
  return (
    <>
      <SectionHeader title="Emergency contact" subtitle="Who to call if something happens on site." />
      <Field label="Name *"><input style={inputStyle} value={form.emergency_name} onChange={e => set({ emergency_name: e.target.value })} /></Field>
      <Field label="Relationship *"><input style={inputStyle} value={form.emergency_relationship} onChange={e => set({ emergency_relationship: e.target.value })} placeholder="e.g. Partner, Parent, Sibling" /></Field>
      <Field label="Phone *"><input style={inputStyle} type="tel" value={form.emergency_phone} onChange={e => set({ emergency_phone: e.target.value })} placeholder="04xx xxx xxx" /></Field>
      <Field label="Alternate phone (optional)"><input style={inputStyle} type="tel" value={form.emergency_phone_alt} onChange={e => set({ emergency_phone_alt: e.target.value })} /></Field>
    </>
  );
}

function StepMedical({ form, set }) {
  return (
    <>
      <SectionHeader title="Medical" subtitle="Helps first-aid responders on site. Only visible to authorised payroll admins." />
      <Field label="Blood type (if known)">
        <select style={inputStyle} value={form.blood_type} onChange={e => set({ blood_type: e.target.value })}>
          <option value="">—</option>
          {['A+','A-','B+','B-','O+','O-','AB+','AB-'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Allergies" hint="Bee stings, latex, penicillin, foods — anything emergency responders should know.">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} value={form.allergies} onChange={e => set({ allergies: e.target.value })} />
      </Field>
      <Field label="Medical conditions" hint="Diabetes, asthma, epilepsy, heart conditions, etc.">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} value={form.conditions} onChange={e => set({ conditions: e.target.value })} />
      </Field>
      <Field label="Current medications">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} value={form.medications} onChange={e => set({ medications: e.target.value })} />
      </Field>
      <Field label="GP / doctor name"><input style={inputStyle} value={form.gp_name} onChange={e => set({ gp_name: e.target.value })} /></Field>
      <Field label="GP phone"><input style={inputStyle} type="tel" value={form.gp_phone} onChange={e => set({ gp_phone: e.target.value })} /></Field>
      <Field label="Medicare number (optional)"><input style={inputStyle} inputMode="numeric" value={form.medicare_number} onChange={e => set({ medicare_number: e.target.value.replace(/[^0-9 ]/g, '').slice(0, 13) })} placeholder="0000 00000 0 0" /></Field>
    </>
  );
}

function StepReview({ form, profile }) {
  const rows = useMemo(() => [
    ['Name',          profile.name],
    ...(profile.email ? [['Email', profile.email]] : []),
    ['Mobile',        form.mobile || '—'],
    ['DOB',           form.date_of_birth || '—'],
    ['Address',       form.address || '—'],
    ['Licence',       form.drivers_licence_number || '—'],
    ['Work status',   STATUS_LABEL[form.citizenship_status] || form.citizenship_status],
    ['TFN',           form.tfn ? '••• ' + form.tfn.slice(-3) : 'Not provided'],
    ['Tax-free threshold', form.claim_tax_free_threshold ? 'Yes' : 'No'],
    ['HECS / HELP',   form.has_hecs_debt ? 'Yes' : 'No'],
    ['Bank',          form.bank_bsb ? `${form.bank_bsb} · •••${(form.bank_account_number || '').slice(-3)}` : 'Not provided'],
    ['Super',         form.use_default_super ? 'CBD default fund' : (form.super_fund_name || 'Not provided')],
    ['Emergency',     form.emergency_name ? `${form.emergency_name} · ${form.emergency_relationship} · ${form.emergency_phone}` : '—'],
    ['Allergies',     form.allergies || '—'],
    ['Conditions',    form.conditions || '—'],
  ], [form, profile]);

  return (
    <>
      <SectionHeader title="Review & submit" subtitle="Last check. Sensitive fields are partially masked." />
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        {rows.map(([k, v], i) => (
          <div key={k} style={{
            display: 'flex', gap: 14,
            padding: '7px 12px',
            borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
            fontSize: 12.5,
          }}>
            <div style={{ flex: '0 0 110px', color: C.textMuted }}>{k}</div>
            <div style={{ flex: 1, color: C.text, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(34,197,94,0.10)', border: `1px solid rgba(34,197,94,0.3)`, borderRadius: 8, fontSize: 12, color: C.success, lineHeight: 1.55 }}>
        After submitting we'll email you a sign-in link to <strong>{profile.email || 'your email'}</strong> so you can log in and see your bookings.
      </div>
    </>
  );
}

const STATUS_LABEL = {
  citizen: 'Australian citizen',
  permanent_resident: 'Permanent resident',
  visa: 'Visa worker',
  other: 'Other',
};

// ── Photo uploader (Supabase Storage) ──────────────────────────────────────

function PhotoUploader({ workerId, value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr]             = useState(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);

    if (file.size > 8 * 1024 * 1024) {
      setErr('Photo is too large. Keep it under 8 MB.');
      return;
    }
    const okType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    if (!okType) {
      setErr('Use a JPG, PNG or WEBP image.');
      return;
    }

    setUploading(true);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${workerId}/profile-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('worker-photos')
      .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
    if (upErr) {
      setErr(upErr.message || 'Upload failed.');
      setUploading(false);
      return;
    }
    const { data: pub } = supabase.storage.from('worker-photos').getPublicUrl(path);
    onChange(pub.publicUrl);
    setUploading(false);
  };

  return (
    <Field label="Profile photo (optional)" hint="A clear head-and-shoulders photo helps the supervisor recognise you on site.">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: C.bg, border: `1px solid ${C.border}`,
          backgroundImage: value ? `url(${value})` : 'none',
          backgroundSize: 'cover', backgroundPosition: 'center',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: C.textDim, fontSize: 24, flexShrink: 0,
        }}>
          {!value && '👤'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer', display: 'inline-block' }}>
            {uploading ? 'Uploading…' : (value ? 'Replace photo' : 'Choose photo')}
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} style={{ display: 'none' }} />
          </label>
          {err && <div style={{ marginTop: 6, fontSize: 11.5, color: '#fda4af' }}>{err}</div>}
        </div>
      </div>
    </Field>
  );
}
