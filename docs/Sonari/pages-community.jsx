// Leaderboard, Sponsors, Register pages

function LeaderboardPage({ nav }) {
  const [tab, setTab] = useState('overall');
  const tabs = [
    { id: 'overall', label: 'Overall' },
    { id: 'monthly', label: 'Monthly' },
    { id: 'individuals', label: 'Individuals' },
    { id: 'corporate', label: 'Corporate' },
    { id: 'pool', label: 'By pool' },
    { id: 'first', label: 'First responders' },
    { id: 'consistent', label: 'Consistent supporters' },
  ];

  const filtered = useMemo(() => {
    if (tab === 'individuals') return D.donors.filter(d => d.type === 'individual');
    if (tab === 'corporate') return D.donors.filter(d => d.type === 'corporate');
    return D.donors;
  }, [tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Community</div>
          <h1>Leaderboard</h1>
          <p className="sub muted">Ranking is for recognition only. It grants no claim rights and no payout priority.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary btn-sm"><Icon name="doc" size={14} /> Methodology</button>
        </div>
      </div>

      {/* Spotlight cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        {filtered.slice(0, 3).map((d, i) => (
          <SpotlightDonor key={i} d={d} idx={i} />
        ))}
      </div>

      <div className="lb-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={'lb-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="lb-table">
        <div className="lb-row header">
          <div>Rank</div>
          <div>Donor</div>
          <div>Tier</div>
          <div>Donations</div>
          <div>Total donated</div>
          <div style={{ textAlign: 'right' }}>Latest</div>
        </div>
        {filtered.map((d, i) => (
          <div className="lb-row" key={i}>
            <div className={'lb-rank' + (d.rank <= 3 ? ' top' : '')}>#{d.rank}</div>
            <div className="lb-name">
              <Avatar
                name={d.anon ? '?' : d.name}
                color={sponsorColor(d, i)}
                square={d.type === 'corporate'}
                size={36}
              />
              <div>
                <div style={{ fontWeight: 500 }}>{d.anon ? 'Anonymous Donor' : d.name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                  {d.type === 'corporate' ? 'Corporate sponsor' : 'Individual'} · {d.pools.join(', ')}
                </div>
              </div>
            </div>
            <div><TierBadge tier={d.tier} /></div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ink-muted)' }}>{d.count}</div>
            <div className="lb-amount">{D.fmtUSD(d.total)}</div>
            <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--ink-faint)' }}>{d.when}</div>
          </div>
        ))}
      </div>

      <div className="callout" style={{ marginTop: 22 }}>
        <Icon name="shield" size={16} />
        <div>
          <strong>About ranking:</strong> totals reflect on-chain donations only.
          Anonymous donors appear without a name; donors with "hide amount" enabled
          appear with rank and tier only. Ranking position does not affect claim
          eligibility or payout order.
        </div>
      </div>
    </div>
  );
}

function SpotlightDonor({ d, idx }) {
  const medalColor = idx === 0 ? 'oklch(0.78 0.10 80)' : idx === 1 ? 'oklch(0.78 0.005 200)' : 'oklch(0.72 0.08 50)';
  return (
    <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: 28 }}>
      <div style={{ position: 'absolute', top: 20, right: 20, fontFamily: 'var(--font-serif)', fontSize: 56, color: medalColor, lineHeight: 1, opacity: 0.85 }}>
        #{d.rank}
      </div>
      <Avatar name={d.anon ? '?' : d.name} color={sponsorColor(d, idx)} square={d.type === 'corporate'} size={56} />
      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 18 }}>{d.anon ? 'Anonymous Donor' : d.name}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>
          {d.type === 'corporate' ? 'Corporate sponsor' : 'Individual donor'}
        </div>
      </div>
      <div className="stat-num" style={{ fontSize: 32, marginTop: 18 }}>{D.fmtUSD(d.total)}</div>
      <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: 12, color: 'var(--ink-muted)' }}>
        <span>{d.count} donations</span>
        <span>·</span>
        <span><TierBadge tier={d.tier} /></span>
      </div>
    </div>
  );
}

// =============== Sponsors page ===============
function SponsorsPage({ nav }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Partners</div>
          <h1>Corporate sponsors</h1>
          <p className="sub muted">Verified organizations supporting Sonari's relief reserves. Logos require manual approval; verified sponsors appear in the marquee.</p>
        </div>
        <button className="btn btn-secondary"><Icon name="plus" size={14} /> Apply as sponsor</button>
      </div>

      <div className="eyebrow" style={{ marginBottom: 16 }}>Featured sponsors</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 40 }}>
        {D.sponsors.slice(0, 3).map((s, i) => <FeaturedSponsorCard key={i} sponsor={s} totals={[524800, 412300, 76250][i]} />)}
      </div>

      <div className="eyebrow" style={{ marginBottom: 16 }}>All verified sponsors</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        {D.sponsors.map((s, i) => <SponsorCard key={i} sponsor={s} totals={Math.round(80000 / (i+1))} />)}
      </div>
    </div>
  );
}

function FeaturedSponsorCard({ sponsor, totals }) {
  return (
    <div className="card" style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className="logo-square" style={{ background: sponsor.color, width: 56, height: 56, borderRadius: 14, fontSize: 22 }}>{sponsor.logo}</div>
        <div>
          <h3>{sponsor.name}</h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <Tag variant="ok" dot>Verified</Tag>
            <Tag variant="sand">Featured</Tag>
          </div>
        </div>
      </div>
      <div className="divider"></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Mini label="Total donated" value={D.fmtUSD(totals)} />
        <Mini label="Receipts" value="124" />
      </div>
      <div style={{ marginTop: 16, fontSize: 13, color: 'var(--ink-muted)' }}>
        Supports Earthquake Relief and Community Aid programs.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn btn-secondary btn-sm">Visit website <Icon name="arrow-up-right" size={12} /></button>
      </div>
    </div>
  );
}

function SponsorCard({ sponsor, totals }) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="logo-square" style={{ background: sponsor.color, width: 44, height: 44, borderRadius: 12, fontSize: 18, marginBottom: 14 }}>{sponsor.logo}</div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{sponsor.name}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <Tag variant="ok" dot>Verified</Tag>
      </div>
      <div className="stat-num" style={{ fontSize: 22, marginTop: 16 }}>{D.fmtUSD(totals)}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>total donated</div>
    </div>
  );
}

// =============== Register page ===============
function RegisterPage({ nav }) {
  const [step, setStep] = useState(1);
  const [verified, setVerified] = useState(false);
  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Recipient</div>
          <h1>Register as a recipient</h1>
          <p className="sub muted">Issue your MembershipPass and confirm your H3 residence cell. Personal information stays on your device.</p>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 28 }}>
        {['Wallet', 'Membership Pass', 'Residence verification', 'Confirm'].map((label, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: step > i ? 'var(--sage-700)' : step === i + 1 ? 'var(--sage-200)' : 'var(--cream-200)',
              color: step > i ? 'var(--cream-50)' : step === i + 1 ? 'var(--sage-800)' : 'var(--ink-faint)',
              display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 600
            }}>
              {step > i ? <Icon name="check" size={14} /> : i + 1}
            </div>
            <div style={{ fontSize: 13, fontWeight: step === i + 1 ? 600 : 400, color: step >= i + 1 ? 'var(--sage-900)' : 'var(--ink-muted)' }}>{label}</div>
            {i < 3 && <div style={{ flex: 1, height: 1, background: 'var(--line)', marginRight: 12 }}></div>}
          </div>
        ))}
      </div>

      <div className="card card-lg">
        {step === 1 && (
          <>
            <h3>Connect your wallet</h3>
            <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
              Sonari only stores your wallet address. No name, email, or phone number is collected.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 24 }}>
              {['Sui Wallet', 'Suiet', 'Phantom'].map((w) => (
                <button key={w} className="option" style={{ textAlign: 'left' }}>
                  <div className="title">{w}</div>
                  <div className="desc">Connect to register</div>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 24 }}>
              <button className="btn btn-primary" onClick={() => setStep(2)}>Continue with Sui Wallet</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h3>Mint your MembershipPass</h3>
            <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
              The MembershipPass is a soulbound object. It records that you're eligible to claim if a disaster affects your registered cell.
            </p>
            <div style={{ marginTop: 24, padding: 24, background: 'var(--sage-50)', border: '1px solid var(--sage-200)', borderRadius: 'var(--radius-md)' }}>
              <div className="eyebrow">Pass preview</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', marginTop: 14 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-serif)', fontSize: 28, color: 'var(--sage-900)' }}>Membership Pass</div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>pass_mr_····_····</div>
                </div>
                <Tag variant="neutral">Not yet active</Tag>
              </div>
            </div>
            <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn-primary" onClick={() => setStep(3)}>Mint Pass</button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <h3>Verify your residence</h3>
            <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
              We use your device location to compute a hashed H3 cell. Your raw address never leaves this device.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 24 }}>
              <PrivacyRow label="Raw address" status="kept-on-device" />
              <PrivacyRow label="Phone number" status="not-collected" />
              <PrivacyRow label="Email" status="not-collected" />
              <PrivacyRow label="GPS history" status="not-collected" />
              <PrivacyRow label="Device info" status="not-collected" />
              <PrivacyRow label="H3 cell hash" status="published" />
            </div>
            <div style={{ marginTop: 24, padding: 20, background: 'var(--cream-50)', border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div className="eyebrow">Detected cell</div>
                  <div className="mono" style={{ marginTop: 8, fontSize: 14 }}>h3-8928308280fffff</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4 }}>Tokyo, JP · approx 0.74 km²</div>
                </div>
                <button className="btn btn-secondary btn-sm">Refresh</button>
              </div>
            </div>
            <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" onClick={() => setStep(2)}>Back</button>
              <button className="btn btn-primary" onClick={() => { setVerified(true); setStep(4); }}>Sign &amp; verify</button>
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--sage-700)', color: 'var(--cream-50)', display: 'grid', placeItems: 'center', margin: '0 auto 20px' }}>
                <Icon name="check" size={28} />
              </div>
              <h3 style={{ fontSize: 24 }}>You're registered.</h3>
              <p className="muted" style={{ marginTop: 10, maxWidth: 460, margin: '10px auto 0' }}>
                If a finalized disaster affects your cell, you'll see a claimable event on the Claim page.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
                <button className="btn btn-secondary" onClick={() => nav('dashboard')}>View dashboard</button>
                <button className="btn btn-primary" onClick={() => nav('claim')}>Go to claim page</button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="callout" style={{ marginTop: 22 }}>
        <Icon name="lock" size={16} />
        <div>
          Sonari never publishes your raw address, phone, email, GPS trace, or device fingerprint. The only on-chain reference to your residence is a hashed H3 cell.
        </div>
      </div>
    </div>
  );
}

function PrivacyRow({ label, status }) {
  const map = {
    'kept-on-device': { tag: 'On device only', variant: 'ok', icon: 'lock' },
    'not-collected': { tag: 'Not collected', variant: 'neutral', icon: 'eye' },
    'published': { tag: 'Hashed · on-chain', variant: 'sand', icon: 'globe' },
  };
  const m = map[status];
  return (
    <div style={{ padding: 14, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Icon name={m.icon} size={15} />
        <span style={{ fontSize: 14 }}>{label}</span>
      </div>
      <Tag variant={m.variant}>{m.tag}</Tag>
    </div>
  );
}

Object.assign(window, { LeaderboardPage, SponsorsPage, RegisterPage, SpotlightDonor, FeaturedSponsorCard, SponsorCard, PrivacyRow });
