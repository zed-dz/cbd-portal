// Brand config — the one file that differs between the portals (CBD / MRA /
// Hecate) so shared screens stay byte-identical. CBD's theme.js keeps its own
// orange tokens; this file exists so new shared modules (Sales partners) can
// read the name without hard-coding it.

export const BRAND = {
  shortName: 'CBD',                  // wordmark / logo text
  fullName:  'CBD Plant & Labour',   // formal name used in emails + footers
  tagline:   'Operations Portal',    // appears under the wordmark
  abn:       '75 663 693 070',       // hidden when empty
  opsContact: '',
  region:    'AU',

  accent:      '#f97316',
  accentHover: '#fb923c',
  accentSoft:  'rgba(249,115,22,0.12)',
  accentBorder:'rgba(249,115,22,0.32)',
};

export function brandFooterLine() {
  const parts = [BRAND.fullName, BRAND.abn && `ABN ${BRAND.abn}`].filter(Boolean);
  return parts.join(' · ');
}
