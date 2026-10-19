// CSP guard: production sends `script-src 'self'`, so any inline <script> or
// inline event handler in the built index.html would be blocked on the live
// site (a white screen). Builds must use INLINE_RUNTIME_CHUNK=false.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures/test');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, process.env.E2E_BUILD_DIR || 'build-e2e');

test.describe('CSP guard', () => {
  test.skip(({ isMobile }) => !isMobile, 'static checks: run once (phone project)');

  test('built index.html has no inline <script> and no inline event handlers', async () => {
    const html = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8');
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    expect(scripts.length, 'the app bundle should be loaded by <script src>').toBeGreaterThan(0);
    const inline = scripts.filter(s => !/\bsrc\s*=/.test(s.slice(0, s.indexOf('>') + 1)) || !/^<script\b[^>]*>\s*<\/script>$/i.test(s));
    expect(inline, 'inline <script> in index.html (set INLINE_RUNTIME_CHUNK=false)').toEqual([]);
    expect(html.match(/\son[a-z]+\s*=/gi) || [], 'inline event handler attributes').toEqual([]);
  });

  test('vercel.json keeps an enforced, strict script-src and the camera permission', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const headers = Object.fromEntries(((cfg.headers || []).find(h => h.source === '/(.*)')?.headers || []).map(h => [h.key, h.value]));
    expect(headers['Content-Security-Policy-Report-Only'], 'CSP must be enforced, not report-only').toBeUndefined();
    const csp = headers['Content-Security-Policy'] || '';
    const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src ')) || '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(headers['Permissions-Policy']).toContain('camera=(self)');
  });

  test('the app boots under the production CSP (served by e2e/serve.js)', async ({ page }) => {
    const res = await page.goto('/');
    expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // The guard fixture fails this test on any CSP violation logged to the console.
  });
});
