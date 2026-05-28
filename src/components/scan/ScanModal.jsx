import { useState, useEffect, useRef } from 'react';
import { C, R, MONO, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Modal, Spinner, Badge } from '../index';

// Browser BarcodeDetector support varies — Chrome (Android/desktop) supports QR + Code128.
// Safari & Firefox don't. We feature-detect and gracefully degrade to photo-only.
const hasBarcodeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

export function ScanModal({ onClose, showToast }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const detectIntervalRef = useRef(null);

  const [error, setError]     = useState(null);
  const [starting, setStart]  = useState(true);
  const [detected, setDetected] = useState(null); // { value, format }
  const [capture, setCapture]   = useState(null); // { dataUrl, blob, width, height }
  const [facingMode, setFacingMode] = useState('environment');
  const [retryNonce, setRetryNonce] = useState(0);

  // Start / restart camera when facingMode changes.
  useEffect(() => {
    let cancelled = false;
    setStart(true);
    setError(null);
    setDetected(null);

    (async () => {
      try {
        const constraints = { video: { facingMode: { ideal: facingMode } }, audio: false };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStart(false);

        if (hasBarcodeDetector && !detectorRef.current) {
          // eslint-disable-next-line no-undef
          detectorRef.current = new window.BarcodeDetector({
            formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix'],
          });
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access and try again.'
            : e.name === 'NotFoundError'
              ? 'No camera found on this device.'
              : e.message || 'Could not start camera.';
          setError(msg);
          setStart(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (detectIntervalRef.current) clearInterval(detectIntervalRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [facingMode, retryNonce]);

  // Poll for barcode detections (every 600ms — light enough not to lag).
  useEffect(() => {
    if (!hasBarcodeDetector || starting || error || detected) return;
    const tick = async () => {
      if (!videoRef.current || !detectorRef.current) return;
      try {
        const codes = await detectorRef.current.detect(videoRef.current);
        if (codes && codes.length > 0) {
          const first = codes[0];
          setDetected({ value: first.rawValue, format: first.format });
        }
      } catch (e) { /* ignore frame errors */ }
    };
    detectIntervalRef.current = setInterval(tick, 600);
    return () => clearInterval(detectIntervalRef.current);
  }, [starting, error, detected]);

  const handleCapture = () => {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement('canvas');
    canvas.width  = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { showToast('Capture failed.', 'error'); return; }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      setCapture({ dataUrl, blob, width: canvas.width, height: canvas.height });
    }, 'image/jpeg', 0.92);
  };

  const downloadCapture = () => {
    if (!capture) return;
    const url = URL.createObjectURL(capture.blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `cbd-scan-${ts}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Photo saved to your downloads', 'success');
  };

  const copyDetected = async () => {
    if (!detected) return;
    try {
      await navigator.clipboard.writeText(detected.value);
      showToast('Copied scanned value to clipboard', 'success');
    } catch (e) { showToast(detected.value, 'info'); }
  };

  const looksLikeUrl = detected && /^https?:\/\//i.test(detected.value);
  const flipCamera = () => setFacingMode(m => m === 'environment' ? 'user' : 'environment');
  const tryAgain   = () => { setDetected(null); setCapture(null); };

  return (
    <Modal title="📷 Scan" onClose={onClose} width={520}>
      {!hasBarcodeDetector && !error && (
        <div style={{
          background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.32)',
          borderRadius: R.md, padding: '8px 12px', marginBottom: 14,
          fontSize: 11.5, color: '#fde68a',
        }}>
          ⓘ QR/barcode auto-detection isn't supported in this browser (use Chrome on Android/desktop for it). Photo capture still works.
        </div>
      )}

      {/* Camera viewport */}
      <div style={{
        position: 'relative', width: '100%', aspectRatio: '4 / 3',
        background: '#000', borderRadius: R.md, overflow: 'hidden',
        border: `1px solid ${C.border}`,
      }}>
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            display: capture ? 'none' : 'block',
            transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
          }}
        />
        {capture && (
          <img src={capture.dataUrl} alt="Captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}

        {starting && !error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexDirection: 'column', gap: 10, background: 'rgba(0,0,0,0.4)' }}>
            <Spinner size={28} />
            <span style={{ fontSize: 12, color: '#fff', opacity: 0.85 }}>Starting camera…</span>
          </div>
        )}

        {error && (
          <div style={{
            position: 'absolute', inset: 0, padding: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, textAlign: 'center',
            background: 'rgba(0,0,0,0.7)',
          }}>
            <div style={{ fontSize: 30 }}>📵</div>
            <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 600 }}>{error}</div>
          </div>
        )}

        {/* Aiming reticle overlay (only while scanning, no detection yet) */}
        {!starting && !error && !detected && !capture && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{
              width: '60%', aspectRatio: 1, maxWidth: 240,
              border: `2px solid rgba(255,255,255,0.7)`, borderRadius: R.md,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.18)',
              position: 'relative',
            }}>
              {/* Corner accents */}
              {[['nw',0,0],['ne','auto',0],['sw',0,'auto'],['se','auto','auto']].map(([k,l,t]) => (
                <div key={k} style={{
                  position: 'absolute',
                  top: t === 0 ? -2 : 'auto', bottom: t === 'auto' ? -2 : 'auto',
                  left: l === 0 ? -2 : 'auto', right: l === 'auto' ? -2 : 'auto',
                  width: 18, height: 18,
                  borderTop:   t === 0 ? `3px solid ${C.accent}` : 'none',
                  borderBottom:t === 'auto' ? `3px solid ${C.accent}` : 'none',
                  borderLeft:  l === 0 ? `3px solid ${C.accent}` : 'none',
                  borderRight: l === 'auto' ? `3px solid ${C.accent}` : 'none',
                }} />
              ))}
            </div>
          </div>
        )}

        {detected && (
          <div style={{ position: 'absolute', top: 10, left: 10, right: 10 }}>
            <Badge label={`✓ ${detected.format.toUpperCase()} detected`} color="green" />
          </div>
        )}
      </div>

      {/* Detected value */}
      {detected && (
        <div style={{
          marginTop: 14, padding: '12px 14px',
          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.28)',
          borderRadius: R.md,
        }}>
          <div style={{ fontSize: 10.5, color: C.textMuted, letterSpacing: 1.2, textTransform: 'uppercase', fontFamily: MONO, marginBottom: 4 }}>Scanned value</div>
          <div style={{ fontSize: 13.5, color: C.text, wordBreak: 'break-all', fontFamily: MONO, lineHeight: 1.45 }}>
            {detected.value}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={copyDetected} style={btnSmall}>📋 Copy</button>
            {looksLikeUrl && (
              <a href={detected.value} target="_blank" rel="noopener noreferrer" style={{ ...btnSmall, textDecoration: 'none' }}>
                🔗 Open link
              </a>
            )}
            <button onClick={tryAgain} style={btnSmall}>↻ Scan again</button>
          </div>
        </div>
      )}

      {/* Capture preview actions */}
      {capture && (
        <div style={{
          marginTop: 14, padding: '12px 14px',
          background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.25)',
          borderRadius: R.md,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 12, color: C.textMuted }}>
            Photo captured · <span style={{ color: C.text, fontFamily: MONO }}>{capture.width}×{capture.height}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={downloadCapture} style={btnSmall}>⬇ Save</button>
            <button onClick={tryAgain} style={btnSmall}>↻ Retake</button>
          </div>
        </div>
      )}

      {/* Main controls */}
      {!error && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {!capture && (
            <button onClick={handleCapture} disabled={starting} style={{ ...btnPrimary, flex: 1 }}>
              📸 Capture Photo
            </button>
          )}
          <button onClick={flipCamera} disabled={starting} style={btnSecondary} title="Switch camera">
            🔄 Flip
          </button>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => { setError(null); setRetryNonce(n => n + 1); }} style={btnSecondary}>Retry</button>
          <button onClick={onClose} style={btnPrimary}>Close</button>
        </div>
      )}
    </Modal>
  );
}
