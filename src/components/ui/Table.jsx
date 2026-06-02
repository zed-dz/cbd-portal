import { C, R, MONO } from '../../theme';

export function TableWrap({ children }) {
  return (
    <div style={{
      overflowX: 'auto',
      borderRadius: R.lg,
      border: `1px solid ${C.border}`,
      background: C.card,
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        color: C.text, fontSize: 13,
      }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, align = 'left' }) {
  return (
    <th style={{
      padding: '11px 14px',
      textAlign: align,
      color: C.textMuted,
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      background: C.bg,
      borderBottom: `1px solid ${C.border}`,
      fontFamily: MONO,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', onClick, title, style }) {
  return (
    <td
      onClick={onClick}
      title={title}
      style={{
        padding: '11px 14px',
        textAlign: align,
        borderBottom: `1px solid ${C.border}`,
        verticalAlign: 'middle',
        ...style,
      }}>
      {children}
    </td>
  );
}
