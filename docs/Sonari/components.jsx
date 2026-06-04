// Shared UI atoms and small components
const { useState, useEffect, useRef, useMemo } = React;
const D = window.SonariData;

// Icons (inline SVG, sage stroke)
function Icon({ name, size = 18, stroke = 'currentColor', strokeWidth = 1.6 }) {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'heart': return <svg {...props}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>;
    case 'shield': return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>;
    case 'sprout': return <svg {...props}><path d="M7 20h10"/><path d="M12 20V8"/><path d="M12 8c0-3 2-5 5-5 0 3-2 5-5 5z"/><path d="M12 12c0-2-2-4-5-4 0 2 2 4 5 4z"/></svg>;
    case 'waves': return <svg {...props}><path d="M2 6c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/><path d="M2 12c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/><path d="M2 18c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/></svg>;
    case 'globe': return <svg {...props}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z"/></svg>;
    case 'eye': return <svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'lock': return <svg {...props}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
    case 'gift': return <svg {...props}><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13"/><path d="M3 13h18"/><path d="M12 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/><path d="M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>;
    case 'arrow-right': return <svg {...props}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>;
    case 'arrow-up-right': return <svg {...props}><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>;
    case 'check': return <svg {...props}><path d="M20 6 9 17l-5-5"/></svg>;
    case 'plus': return <svg {...props}><path d="M12 5v14"/><path d="M5 12h14"/></svg>;
    case 'wallet': return <svg {...props}><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 13h2"/></svg>;
    case 'spark': return <svg {...props}><path d="M12 3v6"/><path d="M12 15v6"/><path d="M3 12h6"/><path d="M15 12h6"/><path d="m5.6 5.6 4.2 4.2"/><path d="m14.2 14.2 4.2 4.2"/><path d="m5.6 18.4 4.2-4.2"/><path d="m14.2 9.8 4.2-4.2"/></svg>;
    case 'verified': return <svg {...props}><path d="M12 2 9.5 5 6 4l-1 3.5L2 9.5 4 13l-2 3.5L5 18l1 3.5L9.5 19 12 22l2.5-3 3.5 1 1-3.5 3-2-2-3.5 2-3.5L18 4l-1-3.5L13.5 5 12 2z"/><path d="m9 12 2 2 4-4"/></svg>;
    case 'map-pin': return <svg {...props}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>;
    case 'clock': return <svg {...props}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>;
    case 'doc': return <svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>;
    case 'menu': return <svg {...props}><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>;
    case 'settings': return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.17.74.27 1.13.27H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case 'bolt': return <svg {...props}><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8z"/></svg>;
    case 'flower': return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M12 3a3 3 0 0 0-3 3c0 1.66 1.34 3 3 3"/><path d="M12 21a3 3 0 0 1-3-3c0-1.66 1.34-3 3-3"/><path d="M3 12a3 3 0 0 0 3 3c1.66 0 3-1.34 3-3"/><path d="M21 12a3 3 0 0 1-3 3c-1.66 0-3-1.34-3-3"/></svg>;
    default: return null;
  }
}

// Brand mark
function BrandMark({ size = 32 }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, borderRadius: size * 0.28 }}>
      <img src="assets/sonari_logo.png" alt="Sonari" />
    </div>
  );
}

// Tag
function Tag({ children, variant = 'default', dot = false }) {
  const cls = 'tag' + (variant !== 'default' ? ' tag-' + variant : '') + (dot ? ' tag-dot' : '');
  return <span className={cls}>{children}</span>;
}

// Tier badge
function TierBadge({ tier }) {
  if (!tier || tier === 'none') return null;
  return <span className={`tier-badge tier-${tier}`}>{tier}</span>;
}

// Avatar
function Avatar({ name, color, size = 36, square = false, image = null }) {
  const initial = (name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
  return (
    <div
      className={'avatar' + (square ? ' avatar-sq' : '')}
      style={{ width: size, height: size, background: color || 'var(--sage-500)', fontSize: size * 0.42 }}
    >
      {image ? <img src={image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
    </div>
  );
}

// Wallet button
function WalletButton({ connected = true, address = '0x9a3f…c21d' }) {
  return (
    <button className="wallet-btn">
      {connected ? (
        <>
          <span className="wallet-dot"></span>
          <span className="mono">{address}</span>
        </>
      ) : (
        <>
          <Icon name="wallet" size={15} />
          Connect Wallet
        </>
      )}
    </button>
  );
}

// Stat card
function StatCard({ label, value, unit, meta, accent }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <span style={{ fontFamily: 'var(--font-sans)', fontSize: 16, marginLeft: 6, color: 'var(--ink-muted)' }}>{unit}</span>}</div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

// Section header
function SectionHeader({ eyebrow, title, sub, action }) {
  return (
    <div className="section-title-row">
      <div>
        {eyebrow && <div className="eyebrow" style={{ marginBottom: 10 }}>{eyebrow}</div>}
        <h2>{title}</h2>
        {sub && <p className="sub muted" style={{ marginTop: 12 }}>{sub}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// Donor row (used in dashboard / leaderboard preview)
function DonorRow({ d, idx, showRank = true }) {
  const colors = D.avatarColors;
  const color = sponsorColor(d, idx);
  const name = d.anon ? 'Anonymous Donor' : d.name;
  return (
    <div className="row-item">
      <Avatar name={d.anon ? '?' : d.name} color={color} square={d.type === 'corporate'} />
      <div>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{name} {d.tier && <span style={{ marginLeft: 8 }}><TierBadge tier={d.tier} /></span>}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>
          {d.type === 'corporate' ? 'Corporate sponsor' : 'Individual'} · {d.count} donations · {d.pools.join(', ')}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="stat-num" style={{ fontSize: 18 }}>{D.fmtUSD(d.total)}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{d.when}</div>
      </div>
    </div>
  );
}

function sponsorColor(d, idx) {
  if (d.anon) return 'oklch(0.7 0.005 145)';
  if (d.type === 'corporate') {
    const found = D.sponsors.find((s) => s.name === d.name);
    return found?.color || 'oklch(0.55 0.06 145)';
  }
  return D.avatarColors[(idx || 0) % D.avatarColors.length];
}

// Export to global
Object.assign(window, {
  Icon, BrandMark, Tag, TierBadge, Avatar, WalletButton,
  StatCard, SectionHeader, DonorRow, sponsorColor,
});
