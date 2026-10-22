import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSecondary, btnSmall } from '../../theme';
import { Spinner, EmptyState } from '../../components';

// Video guide (2026-10-22): the narrated office walkthrough, inside the portal.
// Everything comes from the private `video-guide` bucket: `guide.json` (chapters,
// steps with their times, the words the voice says), one mp4 + poster + subtitles
// per chapter, and the full master. Pick a chapter, or a single step inside it,
// or search for a word and jump straight to the step that mentions it.
// "Watched" ticks are per browser (localStorage) and nothing else is stored.

const BUCKET = 'video-guide';
const WATCHED_KEY = 'cbd.videoGuide.watched';
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const readWatched = () => { try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '[]'); } catch { return []; } };

async function signed(names, seconds = 3600) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(names, seconds);
  if (error) throw error;
  return Object.fromEntries(data.map(d => [d.path, d.signedUrl]));
}

export function VideoGuidePage({ showToast }) {
  const [guide, setGuide] = useState(undefined);   // undefined = loading, null = nothing uploaded
  const [urls, setUrls] = useState({});
  const [pick, setPick] = useState(null);           // { kind: 'master' | 'chapter', n }
  const [q, setQ] = useState('');
  const [now, setNow] = useState(0);
  const [watched, setWatched] = useState(readWatched);
  const videoRef = useRef(null);
  const seekTo = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.storage.from(BUCKET).download('guide.json');
        if (error) { setGuide(null); return; }
        const g = JSON.parse(await data.text());
        const names = ['guide.json', g.master.file, g.master.poster, g.master.subtitles, ...g.chapters.flatMap(c => [c.file, c.poster, c.subtitles])];
        setUrls(await signed(names));
        setGuide(g);
        setPick({ kind: 'chapter', n: g.chapters[0].n });
      } catch (e) { showToast(e.message, 'error'); setGuide(null); }
    })();
  }, [showToast]);

  const current = useMemo(() => {
    if (!guide || !pick) return null;
    if (pick.kind === 'master') return { title: 'The whole guide', ...guide.master, steps: guide.chapters.flatMap(c => c.steps.map(s => ({ ...s, t: s.t + c.masterStart, chapter: c.title }))) };
    return guide.chapters.find(c => c.n === pick.n);
  }, [guide, pick]);

  const play = useCallback((kind, n, t) => {
    setPick({ kind, n }); seekTo.current = t ?? 0;
    setTimeout(() => { const v = videoRef.current; if (!v) return; v.currentTime = seekTo.current; v.play().catch(() => {}); }, 60);
  }, []);
  const jump = (t) => { const v = videoRef.current; if (!v) return; v.currentTime = t; v.play().catch(() => {}); };

  const onEnded = () => {
    if (!current || pick.kind !== 'chapter') return;
    const next = readWatched().includes(pick.n) ? readWatched() : [...readWatched(), pick.n];
    try { localStorage.setItem(WATCHED_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    setWatched(next);
    const i = guide.chapters.findIndex(c => c.n === pick.n);
    if (i >= 0 && i < guide.chapters.length - 1) play('chapter', guide.chapters[i + 1].n, 0);
  };

  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => !guide || !needle ? [] : guide.chapters.flatMap(c => c.steps.filter(s => `${s.title} ${s.say}`.toLowerCase().includes(needle)).map(s => ({ ...s, n: c.n, chapter: c.title }))).slice(0, 12), [guide, needle]);

  if (guide === undefined) return <Spinner />;
  if (guide === null) return (
    <div data-area="video guide">
      <h2 style={{ margin: '0 0 6px', color: C.text, fontSize: 20, fontWeight: 800 }}>🎬 Video guide</h2>
      <EmptyState icon="🎬" message="No guide uploaded yet." />
    </div>
  );

  const activeStep = current?.steps?.reduce((a, s) => (s.t <= now + 0.3 ? s : a), null);
  const isActive = (kind, n) => pick?.kind === kind && (kind === 'master' || pick.n === n);
  const tile = (kind, n, label, sub, posterName, on) => (
    <button key={kind + n} onClick={() => play(kind, n, 0)} aria-pressed={on}
      style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 10, alignItems: 'center', textAlign: 'left', width: '100%', minHeight: 56, padding: 6,
        background: on ? C.accentSoft : C.card, border: `1px solid ${on ? C.accentBorder : C.border}`, borderRadius: 10, cursor: 'pointer', color: C.text }}>
      <img src={urls[posterName]} alt="" width={96} height={54} loading="lazy" style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, background: '#000' }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: on ? C.accent : C.text, overflowWrap: 'anywhere' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: C.textDim, marginTop: 2 }}>{sub}</span>
      </span>
    </button>
  );

  return (
    <div data-area="video guide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>🎬 Video guide</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>
            How the office portal works, screen by screen. {guide.chapters.length} chapters, {fmt(guide.master.duration)} in all. {watched.length ? `${watched.length} of ${guide.chapters.length} watched on this device.` : ''}
          </div>
        </div>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 420 }}>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search the guide, e.g. approve, Xero, swap" aria-label="Search the guide" style={{ ...inputStyle, marginBottom: 0 }} />
          {hits.length > 0 && (
            <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', marginTop: 4, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 12px 30px rgba(0,0,0,.45)' }}>
              {hits.map((h, i) => (
                <button key={i} onClick={() => { setQ(''); play('chapter', h.n, h.t); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'none', border: 'none', borderTop: i ? `1px solid ${C.border}` : 'none', color: C.text, cursor: 'pointer', minHeight: 44 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{h.title}</span> <span style={{ color: C.textDim, fontSize: 11.5 }}>· {h.chapter} · {fmt(h.t)}</span>
                  <span style={{ display: 'block', color: C.textMuted, fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.say}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="video-guide-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border}`, aspectRatio: '16 / 9' }}>
            {current && (
              <video ref={videoRef} key={current.file} src={urls[current.file]} poster={urls[current.poster]} controls playsInline preload="metadata" crossOrigin="anonymous"
                onTimeUpdate={e => setNow(e.currentTarget.currentTime)} onEnded={onEnded}
                style={{ width: '100%', height: '100%', display: 'block', background: '#000' }}>
                {urls[current.subtitles] && <track kind="subtitles" srcLang="en" label="English" src={urls[current.subtitles]} />}
              </video>
            )}
          </div>
          {current && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ color: C.text, fontWeight: 800, fontSize: 16 }}>{pick.kind === 'chapter' ? `${current.n} · ` : ''}{current.title}</div>
                <div style={{ color: C.textDim, fontSize: 12 }}>{fmt(current.duration)} · press CC on the player for subtitles</div>
              </div>
              <ol data-area="guide steps" style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gap: 4 }}>
                {current.steps.map((s, i) => {
                  const on = activeStep === s;
                  return (
                    <li key={i}>
                      <button onClick={() => jump(s.t)} aria-current={on ? 'step' : undefined}
                        style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', minHeight: 44, borderRadius: 8, cursor: 'pointer',
                          background: on ? C.accentSoft : 'transparent', border: `1px solid ${on ? C.accentBorder : 'transparent'}`, color: C.text }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, color: on ? C.accent : C.textDim, paddingTop: 2 }}>{fmt(s.t)}</span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>{s.title}{s.chapter ? <span style={{ color: C.textDim, fontWeight: 500 }}> · {s.chapter}</span> : null}</span>
                          <span style={{ display: 'block', color: C.textMuted, fontSize: 12.5, marginTop: 2, lineHeight: 1.45 }}>{s.say}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          {tile('master', 'all', 'The whole guide', `${fmt(guide.master.duration)} · all ${guide.chapters.length} chapters in one`, guide.master.poster, isActive('master'))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 2px' }}>
            <span style={{ color: C.textMuted, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase' }}>Chapters</span>
            {watched.length > 0 && <button onClick={() => { try { localStorage.removeItem(WATCHED_KEY); } catch { /* ignore */ } setWatched([]); }} style={{ ...btnSmall, minHeight: 28, fontSize: 11 }}>Clear ticks</button>}
          </div>
          {guide.chapters.map(c => tile('chapter', c.n, `${watched.includes(c.n) ? '✓ ' : ''}${c.title}`, `${fmt(c.duration)} · ${c.steps.length} steps`, c.poster, isActive('chapter', c.n)))}
          <a href={urls[guide.master.file]} download style={{ ...btnSecondary, textAlign: 'center', textDecoration: 'none', marginTop: 8, minHeight: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⬇ Download the whole guide</a>
        </div>
      </div>
      <style>{`@media (max-width: 820px) { .video-guide-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
