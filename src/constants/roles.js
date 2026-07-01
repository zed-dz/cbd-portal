// Master role list — the single source of truth for the colour-coded roles a
// worker can be allocated to / actually perform on site. Reused by the
// allocation form, the worker allocation card, and the worker timesheet
// "role performed" selector so the list + colours stay identical everywhere.
//
// Each role has an optional short competency code and inherits its group colour.
// To add a role, drop it in the right group; nothing else needs changing.

export const ROLE_GROUPS = [
  {
    category: 'General',
    color: '#38bdf8', // sky
    roles: [
      { name: 'General Labourer' },
      { name: 'Leading Hand' },
      { name: 'Dogman', code: 'DG' },
      { name: 'Boomlift Operator (EWP - Over 11m)', code: 'EWP' },
    ],
  },
  {
    category: 'Operator',
    color: '#f97316', // brand orange
    roles: [
      { name: 'Operator - Backhoe', code: 'LB' },
      { name: 'Operator - Compactor', code: 'LC' },
      { name: 'Operator - Dozer', code: 'LZ' },
      { name: 'Operator - Excavator', code: 'LE' },
      { name: 'Operator - Grader', code: 'LG' },
      { name: 'Operator - Rubber Duck' },
      { name: 'Operator - Scrapper', code: 'LP' },
      { name: 'Operator - Wheeled Loader', code: 'WLL' },
    ],
  },
  {
    category: 'Skilled Labourer',
    color: '#22c55e', // green
    roles: [
      { name: 'Skilled Labourer - Articulated Haul Truck', code: 'AH' },
      { name: 'Skilled Labourer - Asbestos Awareness (High Risk)' },
      { name: 'Skilled Labourer - Boomlift (BL - Under 11m)', code: 'BL' },
      { name: 'Skilled Labourer - Confined Spaces (High Risk)' },
      { name: 'Skilled Labourer - Front Tipping Dumper', code: 'FTD' },
      { name: 'Skilled Labourer - Quick Cut Saw', code: 'SC' },
      { name: 'Skilled Labourer - Road Saw', code: 'RS' },
      { name: 'Skilled Labourer - Roller', code: 'LR' },
      { name: 'Skilled Labourer - Scissorlift', code: 'SL' },
    ],
  },
];

// Flat lookup: role name → { code, color, category }.
export const ROLE_META = ROLE_GROUPS.reduce((acc, g) => {
  g.roles.forEach(r => { acc[r.name] = { code: r.code || null, color: g.color, category: g.category }; });
  return acc;
}, {});

export const ALL_ROLE_NAMES = ROLE_GROUPS.flatMap(g => g.roles.map(r => r.name));

// Colour for a role name (falls back to brand orange for unknown/legacy roles).
export function roleColor(name) {
  return (name && ROLE_META[name]?.color) || '#f97316';
}

// Short code for a role name (e.g. "LE"), or '' when the role has none.
export function roleCode(name) {
  return (name && ROLE_META[name]?.code) || '';
}

// Inline style for a small coloured role chip, consistent everywhere.
export function roleChipStyle(name) {
  const c = roleColor(name);
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    background: `${c}22`, // ~13% alpha
    color: c,
    fontFamily: '"DM Mono", monospace',
    whiteSpace: 'nowrap',
  };
}
