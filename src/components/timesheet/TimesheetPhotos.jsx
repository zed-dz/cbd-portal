import { useEffect, useState } from 'react';
import { C } from '../../theme';
import { listTimesheetPhotos } from '../../utils/timesheetPhotos';

// Thumbnails for a saved timesheet (office detail view + the worker's own
// view). Each opens its signed URL in a new tab. Renders nothing when there
// are no photos or the viewer may not see them (anonymous supervisor page).
export function TimesheetPhotos({ headerId }) {
  const [photos, setPhotos] = useState([]);
  useEffect(() => {
    let mounted = true;
    if (!headerId) { setPhotos([]); return undefined; }
    listTimesheetPhotos(headerId).then(rows => { if (mounted) setPhotos(rows); });
    return () => { mounted = false; };
  }, [headerId]);

  if (!photos.length) return null;
  return (
    <div style={{ marginTop: 14 }} data-area="timesheet photos">
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        📷 Photos ({photos.length}) — dockets / plant hours, not on the client PDF
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {photos.map(p => (
          <a key={p.id} href={p.url || '#'} target="_blank" rel="noopener noreferrer" title={p.caption || 'Open photo'}
            style={{ display: 'block', width: 88, height: 88, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}`, background: C.card }}>
            {p.url
              ? <img src={p.url} alt={p.caption || 'Docket'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: 11, color: C.textMuted, padding: 6, display: 'block' }}>No preview</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
