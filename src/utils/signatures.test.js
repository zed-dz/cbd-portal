import { signatureProblem, shortDevice, buildSignedCopyHtml, SIGNATURE_MAX_BYTES, SIGNATURE_MIN_CHARS } from './signatures';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
// A drawing long enough to be a real mark (the floor is SIGNATURE_MIN_CHARS).
const DRAWN = PNG + 'A'.repeat(1200);

describe('signatureProblem', () => {
  test('empty signature is refused', () => {
    expect(signatureProblem('')).toMatch(/Sign with your finger/);
    expect(signatureProblem(null)).toMatch(/Sign with your finger/);
  });
  test('non-PNG data is refused', () => {
    expect(signatureProblem('data:image/jpeg;base64,abc')).toMatch(/could not be read/);
  });
  test('over the cap is refused, at the cap is fine', () => {
    const atCap = PNG + 'A'.repeat(SIGNATURE_MAX_BYTES - PNG.length);
    expect(signatureProblem(atCap)).toBeNull();
    expect(signatureProblem(atCap + 'A')).toMatch(/too large/);
  });
  test('a normal drawing passes', () => {
    expect(signatureProblem(DRAWN)).toBeNull();
  });
  test('a blank / tiny PNG is refused (same floor as the server)', () => {
    expect(SIGNATURE_MIN_CHARS).toBe(1100);
    expect(signatureProblem(PNG)).toMatch(/too small/);
    const justUnder = PNG + 'A'.repeat(SIGNATURE_MIN_CHARS - PNG.length - 1);
    expect(signatureProblem(justUnder)).toMatch(/too small/);
    expect(signatureProblem(justUnder + 'A')).toBeNull();
  });
});

describe('shortDevice', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Android phone · Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Android phone · Samsung Internet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0', 'Windows · Edge'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Mac · Safari'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Windows · Firefox'],
  ])('%s', (ua, want) => {
    expect(shortDevice(ua)).toBe(want);
  });
  test('missing user agent', () => {
    expect(shortDevice('')).toBe('—');
    expect(shortDevice(null)).toBe('—');
  });
});

describe('buildSignedCopyHtml', () => {
  const base = {
    kind: 'Site induction', title: 'Appin — site induction', context: 'Appin', text: '1. PPE <always>',
    currentVersion: 2, signedVersion: 2, workerName: 'QA Tester', signedName: 'Q A Tester',
    signedAt: '20/10/2026, 7:01 am', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1',
    signaturePng: PNG,
  };
  test('has the evidence and no script (strict CSP)', () => {
    const html = buildSignedCopyHtml(base);
    expect(html).toContain('Q A Tester');
    expect(html).toContain('203.0.113.9');
    expect(html).toContain('iPhone · Safari');
    expect(html).toContain('v2');
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
  test('escapes the signed text and names', () => {
    const html = buildSignedCopyHtml({ ...base, signedName: '<b>x</b>', text: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  test('a non-PNG signature is never put into the page', () => {
    const html = buildSignedCopyHtml({ ...base, signaturePng: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('none recorded');
  });
  test('an older version gets the note', () => {
    expect(buildSignedCopyHtml({ ...base, signedVersion: 1 })).toContain('signed version 1');
    expect(buildSignedCopyHtml(base)).not.toContain('earlier wording');
  });
  test('prints the stored wording + fingerprint when the row has a snapshot', () => {
    const snap = 'Appin — site induction\nVersion 1\n\n1. PPE <old wording>';
    const sha = 'a'.repeat(64);
    const html = buildSignedCopyHtml({ ...base, signedVersion: 1, currentVersion: 2, snapshot: snap, snapshotSha256: sha });
    expect(html).toContain('1. PPE &lt;old wording&gt;');
    expect(html).not.toContain('1. PPE &lt;always&gt;');      // not today's text
    expect(html).toContain('exact wording this person signed');
    expect(html).toContain(`SHA-256 ${sha}`);
    expect(html).not.toContain('earlier wording is not kept');
    expect(html).not.toMatch(/<script/i);
  });
  test('an old row without a snapshot falls back to the current text with a note', () => {
    const html = buildSignedCopyHtml(base);
    expect(html).toContain('1. PPE &lt;always&gt;');
    expect(html).toContain('before the portal kept a copy');
    expect(html).not.toContain('SHA-256');
  });
  test('never shows money', () => {
    expect(buildSignedCopyHtml(base)).not.toContain('$');
  });
});
