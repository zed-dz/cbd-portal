// Made-up test data for the browser tests. Nothing here is a real person,
// client, site or credential. Dates are computed in Sydney time (the app pins
// every date to Sydney) so the fixtures always describe "today".

const SYDNEY = 'Australia/Sydney';

function sydneyISO(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: SYDNEY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

// Latest date on or before today that is NOT a Tuesday/Thursday: the timesheet
// form demands a Take 5 on Tue/Thu, which would turn an offline test into a
// Take 5 test on two days of the week.
function noTake5Day() {
  for (let i = 0; i < 7; i += 1) {
    const iso = sydneyISO(-i);
    const wd = weekday(iso);
    if (wd !== 2 && wd !== 4) return iso;
  }
  return sydneyISO(0);
}

// Latest Tuesday/Thursday on or before today (a Take 5 day).
function lastTake5Day() {
  for (let i = 0; i < 7; i += 1) {
    const iso = sydneyISO(-i);
    const wd = weekday(iso);
    if (wd === 2 || wd === 4) return iso;
  }
  return sydneyISO(0);
}

const TODAY = sydneyISO(0);
const TAKE5_DAY = lastTake5Day();
const IDS = {
  worker: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  ticketed: '33333333-3333-4333-8333-333333333333',
  workerAuth: 'aaaaaaaa-1111-4111-8111-111111111111',
  adminAuth: 'aaaaaaaa-2222-4222-8222-222222222222',
  client: '44444444-4444-4444-8444-444444444444',
  site: '55555555-5555-4555-8555-555555555555',
  allocation: '66666666-6666-4666-8666-666666666666',
  pastHeader: '77777777-7777-4777-8777-777777777777',
  savedHeader: '88888888-8888-4888-8888-888888888888',
};

const CLIENT_NAME = 'Harbour Civil (test)';
const SITE_NAME = 'Wharf Road Upgrade';

const PASSWORD = 'correct-horse-e2e';

const baseWorker = {
  status: 'active', app_status: 'Active', site: null, client: null,
  job_title: null, licences: null, address: null, worker_type: 'casual',
  subcontractor_abn: null, profile_token: null, profile_invite_sent_at: null,
  qualified: true, archived_at: null, archived_reason: null, archived_notes: null, archived_by: null,
  date_of_birth: null, gender: null, alternate_phone: null, postal_address: null,
  drivers_licence_number: null, drivers_licence_expiry: null, citizenship_status: null,
  visa_subclass: null, visa_expiry: null, claim_tax_free_threshold: null, has_hecs_debt: null,
  emergency_name: null, emergency_relationship: null, emergency_phone: null, emergency_phone_alt: null,
  onboarding_completed_at: '2026-01-05T00:00:00Z', photo_url: null, stripe_account_id: null,
  notify_mode: 'sms', notify_sms: false, notify_email: false, is_allocator: false,
};

function workers() {
  return [
    {
      ...baseWorker, id: IDS.worker, name: 'Sam Taylor', email: 'sam.worker@e2e.test',
      mobile: '0400 000 001', role: 'worker', access_level: 'employee', worker_type: 'casual',
      job_title: 'General Labourer', created_at: '2026-01-05T00:00:00Z',
    },
    {
      ...baseWorker, id: IDS.admin, name: 'Chris Office', email: 'office.admin@e2e.test',
      mobile: '0400 000 002', role: 'admin', access_level: 'admin', worker_type: 'full-time',
      is_allocator: true, created_at: '2026-01-01T00:00:00Z',
    },
    {
      ...baseWorker, id: IDS.ticketed, name: 'Alex Morgan', email: 'alex.ticketed@e2e.test',
      mobile: '0400 000 003', role: 'worker', access_level: 'employee', worker_type: 'casual',
      job_title: 'Operator - Excavator', created_at: '2026-01-06T00:00:00Z',
    },
  ];
}

// Supabase auth users (what /auth/v1/user returns). Separate ids from the
// workers rows on purpose — the app links them by email, like production.
const AUTH_USERS = {
  worker: { id: IDS.workerAuth, email: 'sam.worker@e2e.test', workerId: IDS.worker },
  admin: { id: IDS.adminAuth, email: 'office.admin@e2e.test', workerId: IDS.admin },
};

// One fresh in-memory database per test (the mock mutates it on writes).
function seedTables() {
  return {
    workers: workers(),
    clients: [
      { id: IDS.client, name: CLIENT_NAME, award_profile: null, archived_at: null, created_at: '2026-01-01T00:00:00Z' },
    ],
    client_sites: [
      { id: IDS.site, client_id: IDS.client, name: SITE_NAME, address: '1 Wharf Rd, Sydney NSW 2000', map_link: null, is_active: true },
    ],
    client_jobs: [],
    client_site_contacts: [],
    job_roles: [
      { id: 'jr-1', name: 'General Labourer', archived_at: null },
      { id: 'jr-2', name: 'Operator - Excavator', archived_at: null },
    ],
    allocations: [
      {
        id: IDS.allocation, worker_id: IDS.worker, client: CLIENT_NAME, site: SITE_NAME, project: null,
        role: 'General Labourer', status: 'confirmed', start_date: TODAY, end_date: TODAY,
        start_time: `${TODAY}T20:00:00Z`, address: '1 Wharf Rd, Sydney NSW 2000', map_link: null,
        site_manager: 'Pat Supervisor', manager_phone: '0400 000 099', notes: null,
        created_at: `${TODAY}T00:00:00Z`, group_id: null, series_id: null,
        workers: { name: 'Sam Taylor', job_title: 'General Labourer' },
        allocation_groups: null,
      },
    ],
    allocation_groups: [],
    shift_swap_requests: [],
    timesheet_headers: [
      {
        id: IDS.pastHeader, worker_id: IDS.worker, client: CLIENT_NAME, project: SITE_NAME,
        role: 'General Labourer', total_hours: 8, status: 'approved', comments: 'Kerb and gutter pour',
        created_at: '2026-10-01T08:00:00Z', client_approved_by: 'Pat Supervisor', client_approved_at: '2026-10-02T08:00:00Z',
      },
    ],
    // Kept empty: a saved line would feed the fatigue rest-gap check and make
    // the fatigue test depend on the clock.
    timesheets: [],
    take5: [
      {
        id: 't5-1', worker_id: IDS.worker, work_date: TODAY, site: `${CLIENT_NAME} — ${SITE_NAME}`,
        task: 'Trench support', hazards: 'Plant movement', created_at: `${TODAY}T20:30:00Z`,
      },
      ...(TAKE5_DAY !== TODAY ? [{
        id: 't5-2', worker_id: IDS.worker, work_date: TAKE5_DAY, site: `${CLIENT_NAME} — ${SITE_NAME}`,
        task: 'Kerb pour', hazards: 'Traffic', created_at: `${TAKE5_DAY}T20:30:00Z`,
      }] : []),
    ],
    v_payroll_config: [
      { config_key: 'meal_allowance_trigger', config_value: '9.5' },
      { config_key: 'meal_allowance_amount', config_value: '18.70' },
    ],
    role_required_tickets: [
      { id: 'rt-1', role_name: 'Operator - Excavator', ticket_name: 'Excavator ticket', required: true, archived_at: null },
      { id: 'rt-2', role_name: '*', ticket_name: 'White Card', required: true, archived_at: null },
    ],
    certifications: [
      { id: 'ce-1', worker_id: IDS.ticketed, cert_name: 'Excavator (LE)', expiry: '2030-01-01' },
      { id: 'ce-2', worker_id: IDS.ticketed, cert_name: 'White Card CPCCWHS1001', expiry: null },
    ],
    worker_certificates: [],
    notifications: [],
    leave_requests: [],
    incident_reports: [],
    worker_applications: [],
    activity_events: [],
    client_errors: [],
    clock_events: [],
    company_documents: [],
    policy_categories: [
      { id: 'pc-swms', name: 'SWMS', sort_order: 10, archived_at: null },
      { id: 'pc-take5', name: 'Take 5', sort_order: 20, archived_at: null },
    ],
    policy_documents: [
      { id: 'pd-1', category_id: 'pc-swms', category_name_snapshot: 'SWMS', title: 'Excavation SWMS', description: null,
        file_path: 'pc-swms/1-excavation.pdf', file_name: 'excavation.pdf', mime_type: 'application/pdf', size_bytes: 482000,
        visible_to_workers: true, created_at: '2026-10-20T00:00:00Z', archived_at: null },
    ],
    document_signatures: [],
    plant_items: [],
    plant_hours: [],
  };
}

// RPCs the app calls, answered from the in-memory db. `ctx` = { user, db }.
const RPC = {
  save_daily_timesheet: (args) => args.p_header_id || IDS.savedHeader,
  is_portal_admin: (_a, ctx) => ctx.worker?.access_level === 'admin' && !ctx.worker?.is_allocator,
  is_office_user: (_a, ctx) => ctx.worker?.role === 'admin',
  current_worker_id: (_a, ctx) => ctx.worker?.id || null,
  list_swap_candidates: () => [],
};

module.exports = { TODAY, TAKE5_DAY, IDS, CLIENT_NAME, SITE_NAME, PASSWORD, AUTH_USERS, seedTables, RPC, sydneyISO, noTake5Day };
