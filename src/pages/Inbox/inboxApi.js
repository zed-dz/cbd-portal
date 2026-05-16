import { supabase } from '../../supabaseClient';

// Available {{placeholder}}s in templates. Anything in `extra` overrides these.
const PLACEHOLDER_KEYS = [
  'worker_name', 'worker_email', 'client_name', 'client_contact',
  'week_ending', 'date', 'job', 'site', 'start_time', 'onboard_link',
];

export function interpolate(text, ctx = {}) {
  if (!text) return '';
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key] ?? '';
    return `{{${key}}}`;
  });
}

export function placeholderHints() {
  return PLACEHOLDER_KEYS;
}

export async function modifyThread(threadId, action) {
  const { data, error } = await supabase.functions.invoke('gmail-modify', {
    body: { thread_id: threadId, action },
  });
  if (error || data?.error) {
    throw new Error(data?.error || error?.message || 'Modify failed');
  }
  return data.thread;
}

export async function loadTemplates() {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('name');
  if (error) throw new Error(error.message);
  return data || [];
}

export function buildTemplateContext({ worker, client, allocation, timesheet, onboardLink }) {
  return {
    worker_name:    worker?.name || '',
    worker_email:   worker?.email || '',
    client_name:    client?.name || '',
    client_contact: client?.contact || '',
    week_ending:    timesheet?.week_ending || '',
    date:           allocation?.work_date || '',
    job:            allocation?.client_job_name || allocation?.site || client?.site || '',
    site:           allocation?.site || client?.site || '',
    start_time:     allocation?.start_time || '',
    onboard_link:   onboardLink || '',
  };
}
