# Two-step login (TOTP) — manual test script

Project auth config (read 2026-10-19 via `GET /v1/projects/tsizneslellcqusjwtub/config/auth`):
`mfa_totp_enroll_enabled = true`, `mfa_totp_verify_enabled = true`, `mfa_max_enrolled_factors = 10`.
Nothing was changed; TOTP was already on.

Use a throw-away admin or the office test login, never a real admin. You need an
authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator).

1. Sign in as an office admin → top bar shows the 🔐 button and the amber
   "Add two-step login" nudge (desktop) / amber dot on 🔐 (phone, 360 px).
2. Tap 🔐 → modal "🔐 Two-step login" opens, says "Not set up yet".
3. Tap "Set up with an authenticator app" → a QR code and a secret appear.
4. Scan the QR (or type the secret) in the authenticator app; a 6-digit code starts rotating.
5. Type the current 6 digits → "Turn on" → toast "Two-step login is on"; the factor is listed as Active and the nudge disappears.
6. Sign out, sign in again with email + password → the "Enter your code" screen appears BEFORE the portal (same look as the Set-password screen).
7. Type a wrong code → red error "That code did not work…"; the field clears, no portal access.
8. Type the right code → the admin portal loads. Refresh the page → portal loads straight away (session is already aal2).
9. "Not you? Sign out" on the code screen → back to the sign-in page (no portal flash).
10. Back in the portal: 🔐 → "Remove" next to the factor → confirm → factor gone, nudge back. (Removing is only allowed on a session that passed the code; if you see "sign out and back in", do exactly that.)

Password-reset edge case: a user WITH two-step login who clicks an emailed reset link
sees Set-password first; if Supabase refuses the update at aal1, the code screen is
shown, then Set-password returns. Verify once with a test user.

Expected activity feed rows: `<name> enabled two-step login`, `<name> removed two-step login`.
