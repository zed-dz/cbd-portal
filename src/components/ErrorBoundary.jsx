import { Component } from 'react';
import { C, btnPrimary, btnSecondary } from '../theme';
import { reportClientError } from '../utils/clientErrors';

// Last line of defence: a render crash anywhere shows this card instead of a
// blank white page, and the error is reported to `client_errors`.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportClientError(error, { source: 'react', componentStack: String(info?.componentStack || '').slice(0, 1500) });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || '').slice(0, 200);
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 36 }}>⚠️</div>
          <h2 style={{ color: C.text, fontSize: 18, margin: '8px 0' }}>Something went wrong</h2>
          <p style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.55 }}>
            This page hit an error. Anything you already saved is safe. Reload to continue.
            The error has been reported to the office automatically.
          </p>
          {msg && <p style={{ color: C.textDim, fontSize: 11, fontFamily: '"DM Mono", monospace', marginTop: 10, wordBreak: 'break-word' }}>{msg}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            <button style={btnPrimary} onClick={() => window.location.reload()}>Reload</button>
            <button style={btnSecondary} onClick={() => { window.location.href = '/'; }}>Go to start</button>
          </div>
        </div>
      </div>
    );
  }
}
