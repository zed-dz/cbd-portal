// Columns any signed-in user may read from the workers table. The DB enforces
// this with COLUMN-LEVEL grants (2026-09-28): selecting * or any pay_rate_*
// column as a client role fails outright. Admin screens that genuinely need
// pay read the definer view v_workers_admin instead (all columns, rows only
// for portal admins). Keep this list in sync with the grant in the
// pay-lockdown migration - a NEW workers column is invisible to the app until
// it is added both there and here.
export const WORKER_SAFE_COLS = 'id, name, email, mobile, role, status, app_status, site, client, created_at, job_title, licences, address, access_level, worker_type, subcontractor_abn, profile_token, profile_invite_sent_at, qualified, archived_at, archived_reason, archived_notes, archived_by, date_of_birth, gender, alternate_phone, postal_address, drivers_licence_number, drivers_licence_expiry, citizenship_status, visa_subclass, visa_expiry, claim_tax_free_threshold, has_hecs_debt, emergency_name, emergency_relationship, emergency_phone, emergency_phone_alt, onboarding_completed_at, photo_url, stripe_account_id, notify_mode, notify_sms, notify_email, is_allocator';
