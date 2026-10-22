import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnSecondary } from '../../theme';
import { Spinner, EmptyState } from '../../components';

// Video guide (2026-10-22): the narrated office walkthrough, inside the portal.
// Files live in the private `video-guide` bucket. The master is
// "CBD-Portal-Office-Guide.mp4"; chapter clips are "NN - Title.mp4". The page
// lists what is in the bucket, so uploading a new cut needs no code change.

const BUCKET = 'video-guide';
const MASTER = /office-guide\.mp4$/i;
const CLIP = /^(\d{2}) - (.+)\.mp4$/i;

export function VideoGuidePage({ showToast }) {
  const [files, setFiles] = useState(null);
  const [current, setCurrent] = useState(null);   // { name, title, url }
  const videoRef = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: 100, sortBy: { column: 'name', order: 'asc' } });
    if (error) { showToast(error.message, 'error'); setFiles([]); return; }
    setFiles((data || []).filter(f => /\.mp4$/i.test(f.name)));
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const play = useCallback(async (name, title) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(name, 3600);
    if (error) { showToast(error.message, 'error'); return; }
    setCurrent({ name, title, url: data.signedUrl });
    setTimeout(() => videoRef.current?.play().catch(() => {}), 50);
  }, [showToast]);

  const master = files?.find(f => MASTER.test(f.name));
  const clips = (files || []).filter(f => CLIP.test(f.name)).map(f => ({ ...f, n: f.name.match(CLIP)[1], title: f.name.match(CLIP)[2] }));

  useEffect(() => { if (master && !current) play(master.name, 'The whole guide'); }, [master, current, play]);

  if (files === null) return <Spinner />;
  const sizeMB = (f) => f.metadata?.size ? `${(f.metadata.size / 1048576).toFixed(0)} MB` : '';

  return (
    <div data-area="video guide">
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>🎬 Video guide</h2>
        <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>How the office portal works, screen by screen. Watch the whole thing, or pick the part you need.</div>
      </div>
      {!files.length ? (
        <EmptyState icon="🎬" message="No videos uploaded yet." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }} className="video-guide-grid">
          <div style={{ minWidth: 0 }}>
            <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border}`, aspectRatio: '16 / 9' }}>
              {current && <video ref={videoRef} key={current.url} src={current.url} controls playsInline preload="metadata" style={{ width: '100%', height: '100%', display: 'block', background: '#000' }} />}
            </div>
            {current && <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginTop: 10 }}>{current.title}</div>}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {master && (
              <button onClick={() => play(master.name, 'The whole guide')} aria-pressed={current?.name === master.name}
                style={{ ...btnSecondary, justifyContent: 'space-between', minHeight: 44, textAlign: 'left', fontWeight: 700,
                  background: current?.name === master.name ? C.accentSoft : 'transparent', borderColor: current?.name === master.name ? C.accentBorder : C.border, color: current?.name === master.name ? C.accent : C.text }}>
                <span>▶ The whole guide</span><span style={{ color: C.textDim, fontSize: 11.5, fontWeight: 500 }}>{sizeMB(master)}</span>
              </button>
            )}
            {clips.length > 0 && <div style={{ color: C.textMuted, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', margin: '8px 0 2px' }}>Chapters</div>}
            {clips.map(c => (
              <button key={c.name} onClick={() => play(c.name, c.title)} aria-pressed={current?.name === c.name}
                style={{ ...btnSecondary, justifyContent: 'flex-start', gap: 10, minHeight: 44, textAlign: 'left',
                  background: current?.name === c.name ? C.accentSoft : 'transparent', borderColor: current?.name === c.name ? C.accentBorder : C.border, color: current?.name === c.name ? C.accent : C.text }}>
                <span style={{ fontFamily: 'monospace', color: C.textDim, fontSize: 12 }}>{c.n}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <style>{`@media (max-width: 760px) { .video-guide-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
