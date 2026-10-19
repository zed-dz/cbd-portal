// Builds the app for the browser tests into build-e2e/ (never build/), pointed
// at a FAKE Supabase host that the tests answer with page.route. No real URL,
// no real key, no production data can be reached from this build.
// Same flags as production: CI=true (lint warnings fail), no inline runtime
// chunk (strict CSP), no source maps.
//
// Usage: npm run e2e:build
const { spawnSync } = require('child_process');
const path = require('path');

const env = {
  ...process.env,
  REACT_APP_SUPABASE_URL: process.env.E2E_SUPABASE_URL || 'https://e2e.supabase.test',
  REACT_APP_SUPABASE_ANON_KEY: 'e2e-anon-key-not-a-secret',
  BUILD_PATH: process.env.E2E_BUILD_DIR || 'build-e2e',
  INLINE_RUNTIME_CHUNK: 'false',
  GENERATE_SOURCEMAP: 'false',
  CI: process.env.CI || 'true',
};

const bin = require.resolve('react-scripts/bin/react-scripts.js');
const r = spawnSync(process.execPath, [bin, 'build'], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
});
process.exit(r.status == null ? 1 : r.status);
