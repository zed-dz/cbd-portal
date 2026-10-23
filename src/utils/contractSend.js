// Sending a contract: one function used by the Contracts page, the Add Worker form
// and the application approval. It fills the default template for the worker's type,
// saves the row, and if nothing is missing it sends at once (text + email through the
// office-gated notify-worker function) and logs it. Returns what happened so the
// caller can open the "type the specifics" form when needed.
import { supabase } from '../supabaseClient';
import { logActivity } from './activity';
import { portalBaseUrl } from './inviteLinks';
import { fillTemplate, knownValues, pickTemplate, sendMessage } from './contracts';

export const COMPANY_NAME = process.env.REACT_APP_COMPANY_NAME || 'CBD Plant & Labour Pty Ltd';

export async function loadTemplates() {
  const { data, error } = await supabase.from('contract_templates').select('*').order('worker_type', { nullsFirst: false }).order('name');
  if (error) throw error;
  return data || [];
}

// Build the row for a worker + template (+ typed specifics). Does not save.
export function prepareContract({ worker, template, sender, typed = {} }) {
  const values = { ...knownValues(worker, sender, { name: COMPANY_NAME }), ...typed };
  const { text, missing, used } = fillTemplate(template.body, values);
  return {
    worker_id: worker.id, template_id: template.id, template_name_snapshot: template.name, template_version: template.version || 1,
    title: template.name, body: text, fields: used, missing, status: missing.length ? 'needs_details' : 'sent',
    sent_by_id: sender?.id || null, sent_by_name: sender?.name || null,
  };
}

// Notify the worker that a contract is waiting (fire and forget; the row is the truth).
export function notifyContract(worker) {
  const text = sendMessage((worker.name || '').split(' ')[0], COMPANY_NAME, portalBaseUrl());
  return supabase.functions.invoke('notify-worker', { body: { worker_id: worker.id, kind: 'generic', text } }).catch(e => console.error('notify-worker failed:', e));
}

// Save a prepared row. If it is complete it is sent right away.
export async function saveContract(row, worker, { existingId = null } = {}) {
  const q = existingId
    ? supabase.from('worker_contracts').update({ ...row, status: row.status }).eq('id', existingId).select('id, status').single()
    : supabase.from('worker_contracts').insert([row]).select('id, status').single();
  const { data, error } = await q;
  if (error) throw error;
  if (data.status === 'sent') {
    notifyContract(worker);
    logActivity({ verb: 'sent', object_type: 'worker_contract', object_id: data.id, after: { name: `${row.title} → ${worker.name}` } });
  } else {
    logActivity({ verb: 'prepared', object_type: 'worker_contract', object_id: data.id, after: { name: `${row.title} → ${worker.name}`, missing: row.missing } });
  }
  return data;
}

// The automation: called right after a worker is created. Returns
// { skipped: reason } | { sent: true, id } | { needsDetails: true, id, missing, template }.
export async function autoSendContract({ worker, sender }) {
  if (!worker || worker.role === 'admin') return { skipped: 'office user' };
  let templates;
  try { templates = await loadTemplates(); } catch (e) { return { skipped: 'no access to templates' }; }
  const template = pickTemplate(templates, worker.worker_type);
  if (!template) return { skipped: `no default template for ${worker.worker_type || 'this type'}` };
  const row = prepareContract({ worker, template, sender });
  const saved = await saveContract(row, worker);
  return saved.status === 'sent' ? { sent: true, id: saved.id } : { needsDetails: true, id: saved.id, missing: row.missing, template };
}
