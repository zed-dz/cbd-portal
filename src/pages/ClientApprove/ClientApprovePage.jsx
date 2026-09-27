import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnPrimary, btnSecondary, inputStyle } from '../../theme';
import { Spinner } from '../../components';
import { TimesheetDetailView } from '../../components/timesheet/TimesheetDetailView';

// Public, token-gated page the SITE SUPERVISOR opens from the email/SMS link
// after an admin approves a timesheet (no login — the token is the trust
// boundary, same contract as /p/ and /onboard/). Shows the hours-only
// timesheet; Accept finalises it as billable. "Something's wrong" disputes it
// instead: the office gets a bell and the sheet can never auto-approve.
export function ClientApprovePage({ token }) {
  const [state, setState] = useState('loading'); // loading | notfound | ready | accepting | accepted | disputing | disputed
  const [payload, setPayload] = useState(null);
  const [approver, setApprover] = useState('');
  const [error, setError] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeNote, setDisputeNote] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error: e } = await supabase.rpc('get_timesheet_for_client_approval', { p_token: token });
      if (!mounted) return;
      if (e || !data || !data.header) { setState('notfound'); return; }
      setPayload(data);
      setState(data.header.client_approved ? 'accepted' : 'ready');
    })();
    return () => { mounted = false; };
  }, [token]);

  const accept = async () => {
    setState('accepting');
    setError('');
    const { data, error: e } = await supabase.rpc('approve_timesheet_via_token', {
      p_token: token, p_approver: approver || null,
    });
    if (e || data !== true) {
      setError(e?.message || 'Could not record the approval — please try again or contact the office.');
      setState('ready');
      return;
    }
    // Acceptance triggers the PDF email to the client automatically — the
    // server builds the PDF and sends it, so nobody has to print anything.
    // Fire-and-forget; a failure lights the admin bell server-side.
    supabase.functions.invoke('send-timesheet-pdf', { body: { token, reason: 'supervisor' } }).catch(() => {});
    setPayload(p => ({ ...p, header: { ...p.header, client_approved: true, client_approved_by: approver || null } }));
    setState('accepted');
  };

  const dispute = async () => {
    setState('disputing');
    setError('');
    const { data, error: e } = await supabase.rpc('dispute_timesheet_via_token', {
      p_token: token, p_note: disputeNote.trim() || null,
    });
    if (e || data !== true) {
      setError(e?.message || 'Could not send this to the office — please try again or call us.');
      setState('ready');
      return;
    }
    setState('disputed');
  };

  const shell = (children) => (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '24px 16px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>{children}</div>
    </div>
  );

  if (state === 'loading') return shell(<div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}><Spinner /></div>);

  if (state === 'notfound') return shell(
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: 'center', marginTop: 60 }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 6 }}>Timesheet not available</div>
      <div style={{ fontSize: 13, color: C.textMuted }}>This link is invalid, or the timesheet is no longer awaiting approval. Please contact the office if you believe this is a mistake.</div>
    </div>
  );

  const h = payload.header;
  return shell(
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
      <TimesheetDetailView
        header={h}
        lines={payload.lines || []}
        workerName={h.worker_name}
        hidePrint
      />

      {state === 'accepted' ? (
        <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 10, padding: '16px 20px', marginTop: 18, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.success }}>✓ Timesheet accepted</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
            {h.client_approved_by ? `Accepted by ${h.client_approved_by}. ` : ''}The hours are now finalised for invoicing, and a PDF copy has been emailed to your office automatically. You can close this page.
          </div>
        </div>
      ) : state === 'disputed' ? (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 10, padding: '16px 20px', marginTop: 18, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.warning || '#f59e0b' }}>Thanks — the office has been told and will call you.</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
            This timesheet is on hold — it won't be finalised until the office has sorted it out with you. You can close this page.
          </div>
        </div>
      ) : (
        <div style={{ background: C.accentSoft, border: `1px solid ${C.accentBorder}`, borderRadius: 10, padding: '16px 20px', marginTop: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            Do you accept this timesheet?
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
            Accepting confirms the hours above are correct — they'll be finalised for invoicing. If we don't hear back within 7 days, the timesheet is finalised automatically.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              style={{ ...inputStyle, maxWidth: 260 }}
              placeholder="Your name (optional)"
              value={approver}
              onChange={e => setApprover(e.target.value)}
            />
            <button onClick={accept} disabled={state === 'accepting' || state === 'disputing'} style={{ ...btnPrimary, background: C.success, padding: '10px 26px' }}>
              {state === 'accepting' ? 'Recording…' : '✓ Accept timesheet'}
            </button>
            <button
              onClick={() => setDisputeOpen(o => !o)}
              disabled={state === 'accepting' || state === 'disputing'}
              style={{ ...btnSecondary, padding: '10px 16px', fontSize: 13 }}
            >
              Something's wrong
            </button>
          </div>
          {disputeOpen && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
                Tell us what's wrong and we'll put the timesheet on hold — the office will call you to sort it out.
              </div>
              <textarea
                style={{ ...inputStyle, width: '100%', minHeight: 70, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
                placeholder="e.g. wrong hours on Tuesday, wrong site, worker wasn't here…"
                value={disputeNote}
                onChange={e => setDisputeNote(e.target.value)}
              />
              <div style={{ marginTop: 8 }}>
                <button onClick={dispute} disabled={state === 'disputing' || state === 'accepting'} style={{ ...btnSecondary, padding: '8px 18px', fontSize: 13 }}>
                  {state === 'disputing' ? 'Sending…' : 'Send to the office'}
                </button>
              </div>
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 8 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
