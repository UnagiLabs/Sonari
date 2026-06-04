// Dashboard, Donate, Donor pages
function DashboardPage({ nav }) {
  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Transparency</div>
          <h1>Dashboard</h1>
          <p className="sub muted">A single-glance view of every pool, donation, and verified claim.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary"><Icon name="doc" size={14} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => nav('donate')}><Icon name="heart" size={14} /> Donate</button>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard label="Total donated" value={D.fmtUSD(D.impactStats.totalDonated)} meta={<><span style={{ color: 'var(--ok)' }}>↑ 2.1%</span> · last 7d</>} />
        <StatCard label="Total paid out" value={D.fmtUSD(D.impactStats.totalPaidOut)} meta={<>{D.fmt(D.impactStats.verifiedClaims)} claims · 96% delivery</>} />
        <StatCard label="Active pools" value="3" meta="Main · Earthquake · Ops" />
        <StatCard label="Active programs" value="2" meta="Earthquake Relief · Community Aid" />
      </div>

      <div style={{ marginTop: 24 }}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>Pool balances</div>
        <div className="dash-pool-row">
          {D.pools.map((p) => <PoolCard key={p.id} pool={p} onClick={() => nav('pools')} />)}
        </div>
      </div>

      <div className="dash-grid" style={{ marginTop: 32 }}>
        <div className="col-8 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3>Latest disaster event</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => nav('events')}>All events <Icon name="arrow-right" size={12} /></button>
          </div>
          <DisasterEventCard event={D.events[0]} onClick={() => nav('events')} />
        </div>

        <div className="col-4 card">
          <h3 style={{ marginBottom: 4 }}>Pool snapshot</h3>
          <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>Available balance, by allocation</div>
          <Donut />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
            {D.pools.map((p, i) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: ['var(--sage-600)', 'var(--sage-400)', 'var(--sand-500)'][i] }}></span>
                <span style={{ flex: 1 }}>{p.name}</span>
                <span style={{ fontFamily: 'var(--font-serif)', fontSize: 16 }}>{D.fmtUSD(p.balance)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="col-6 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3>Recent donations</h3>
            <Tag variant="neutral">live</Tag>
          </div>
          <div className="row-list" style={{ marginTop: 8 }}>
            {D.recentDonations.slice(0, 5).map((d, i) => (
              <div className="row-item" key={i}>
                <Avatar name={d.anon ? '?' : d.who} color={sponsorColor({name: d.who, type: d.type, anon: d.anon}, i)} square={d.type === 'corporate'} size={32} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{d.anon ? 'Anonymous Donor' : d.who}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>→ {d.pool} Pool</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-num" style={{ fontSize: 16 }}>{D.fmtUSD(d.amount)}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{d.when}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="col-6 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3>Recent impact receipts</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => nav('receipts')}>All <Icon name="arrow-right" size={12} /></button>
          </div>
          <div className="row-list" style={{ marginTop: 8 }}>
            {D.receipts.slice(0, 5).map((r, i) => (
              <div className="row-item" key={i}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--sage-100)', display: 'grid', placeItems: 'center', color: 'var(--sage-700)' }}>
                  <Icon name="doc" size={15} />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{r.program}</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.id} · {r.anon}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-num" style={{ fontSize: 16 }}>{D.fmtUSD(r.amount)}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.when}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="col-6 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3>Top donors</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => nav('leaderboard')}>Full <Icon name="arrow-right" size={12} /></button>
          </div>
          <div className="row-list">
            {D.donors.filter(d => d.type === 'individual').slice(0, 4).map((d, i) => <DonorRow key={i} d={d} idx={i} />)}
          </div>
        </div>

        <div className="col-6 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3>Top corporate sponsors</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => nav('sponsors')}>All <Icon name="arrow-right" size={12} /></button>
          </div>
          <div className="row-list">
            {D.donors.filter(d => d.type === 'corporate').slice(0, 4).map((d, i) => <DonorRow key={i} d={d} idx={i} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Donut() {
  const total = D.pools.reduce((s, p) => s + p.balance, 0);
  const colors = ['var(--sage-600)', 'var(--sage-400)', 'var(--sand-500)'];
  let offset = 0;
  const r = 60;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
      <svg width="160" height="160" viewBox="0 0 160 160" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--cream-200)" strokeWidth="14" />
        {D.pools.map((p, i) => {
          const frac = p.balance / total;
          const dash = c * frac;
          const dashArr = `${dash} ${c - dash}`;
          const el = <circle key={p.id} cx="80" cy="80" r={r} fill="none" stroke={colors[i]} strokeWidth="14" strokeDasharray={dashArr} strokeDashoffset={-offset} strokeLinecap="butt" />;
          offset += dash;
          return el;
        })}
      </svg>
    </div>
  );
}

function DisasterEventCard({ event, onClick }) {
  const intensity = event.jma ? `JMA ${event.jma}` : event.mmi ? `MMI ${event.mmi}` : '';
  return (
    <div className="event-card" onClick={onClick}>
      <div className="event-mag">
        <div className="label">Mag</div>
        <div className="value">M{event.mag}</div>
      </div>
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Tag variant={event.status === 'finalized' ? 'ok' : event.status === 'candidate' ? 'warn' : 'neutral'} dot>{event.status}</Tag>
          <Tag variant="info">{event.source}</Tag>
        </div>
        <h3 style={{ fontSize: 18 }}>{event.region}</h3>
        <div className="event-meta">
          <span><Icon name="clock" size={12} /> {event.occurred}</span>
          <span><Icon name="map-pin" size={12} /> {D.fmt(event.cells)} affected H3 cells</span>
          <span>{intensity}</span>
          <span>{event.claims} verified claims</span>
        </div>
      </div>
      <div>
        <button className="btn btn-secondary btn-sm">View event <Icon name="arrow-right" size={12} /></button>
      </div>
    </div>
  );
}

// =============== Donate ===============
function DonatePage({ nav }) {
  const [type, setType] = useState('general');
  const [pool, setPool] = useState('main');
  const [amount, setAmount] = useState(100);
  const [anon, setAnon] = useState(false);
  const [hideAmount, setHideAmount] = useState(false);
  const [corporate, setCorporate] = useState(false);

  const donationTypes = [
    { id: 'general', title: 'General donation', desc: '100% to Main Pool', icon: 'heart' },
    { id: 'designated', title: 'Earthquake relief', desc: 'Split: Earthquake + Main', icon: 'bolt' },
    { id: 'operations', title: 'Operations support', desc: '100% to Operations', icon: 'settings' },
  ];

  const splitInfo = useMemo(() => {
    if (type === 'general') return [{ pool: 'Main Pool', pct: 100, amount }];
    if (type === 'operations') return [{ pool: 'Operations Pool', pct: 100, amount }];
    return [
      { pool: 'Earthquake Pool', pct: 80, amount: amount * 0.8 },
      { pool: 'Main Pool',       pct: 20, amount: amount * 0.2 },
    ];
  }, [type, amount]);

  const tier = amount >= 1000 ? 'gold' : amount >= 250 ? 'silver' : amount >= 50 ? 'bronze' : 'none';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Give</div>
          <h1>Donate</h1>
          <p className="sub muted">Every donation flows into a verifiable pool. You'll see exactly where it lands.</p>
        </div>
        <WalletButton />
      </div>

      <div className="donate-grid">
        <div className="donate-form">
          <div className="field">
            <label className="field-label">Donation type</label>
            <div className="option-grid">
              {donationTypes.map((t) => (
                <button key={t.id} className={'option' + (type === t.id ? ' selected' : '')} onClick={() => setType(t.id)}>
                  <div style={{ marginBottom: 12, color: 'var(--sage-700)' }}><Icon name={t.icon} size={20} /></div>
                  <div className="title">{t.title}</div>
                  <div className="desc">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label">Amount (USDC)</label>
            <div className="amount-input-wrap">
              <input
                type="number"
                className="amount-input"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value) || 0)}
                placeholder="0"
              />
              <span className="amount-currency">USDC</span>
            </div>
            <div className="quick-amounts">
              {[25, 50, 100, 250, 1000].map((v) => (
                <button key={v} className={'quick-amount' + (amount === v ? ' active' : '')} onClick={() => setAmount(v)}>
                  ${v}
                </button>
              ))}
            </div>
            <div className="field-hint">Wallet balance: <span className="mono">4,820.50 USDC</span></div>
          </div>

          {type === 'designated' && (
            <div className="callout">
              <Icon name="waves" size={16} />
              <div>
                Designated donations are split to keep the Main Pool resilient.
                The default split is 80% Earthquake / 20% Main; this is configurable in Tweaks.
              </div>
            </div>
          )}

          <div style={{ height: 22 }}></div>

          <div className="field">
            <label className="field-label">Display preferences</label>
            <div style={{ borderTop: '1px solid var(--line)' }}>
              <ToggleRow label="Donate as a corporate sponsor" desc="Requires verified sponsor profile" value={corporate} onChange={setCorporate} />
              <ToggleRow label="Anonymous donor" desc="Your wallet won't be linked to your displayed name" value={anon} onChange={setAnon} />
              <ToggleRow label="Hide amount on leaderboard" desc="Show your rank and tier, but not the amount" value={hideAmount} onChange={setHideAmount} />
            </div>
          </div>

          <div className="callout" style={{ marginTop: 8 }}>
            <Icon name="lock" size={16} />
            <div>
              DonorPass records contribution history only. It does not grant claim
              rights, payout priority, or guaranteed aid.
            </div>
          </div>
        </div>

        {/* Summary */}
        <aside className="summary-card">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Donation summary</div>
          <div className="summary-row">
            <span className="muted">You're giving</span>
            <span className="stat-num" style={{ fontSize: 28 }}>${D.fmt(amount)}</span>
          </div>
          <div className="divider" style={{ margin: '14px 0' }}></div>

          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-faint)', marginBottom: 8 }}>Estimated split</div>
          {splitInfo.map((s, i) => (
            <div className="summary-row" key={i}>
              <span>{s.pool} <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>{s.pct}%</span></span>
              <span className="value mono">${D.fmt(s.amount)}</span>
            </div>
          ))}

          <div className="divider" style={{ margin: '16px 0' }}></div>

          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-faint)', marginBottom: 10 }}>DonorPass preview</div>
          <div style={{ padding: 16, background: 'var(--sage-50)', borderRadius: 'var(--radius-md)', border: '1px solid var(--sage-200)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--sage-800)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Donor Pass</span>
              <TierBadge tier={tier === 'none' ? 'bronze' : tier} />
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 6 }}>pass_0x9a3f…c21d</div>
            <div className="stat-num" style={{ fontSize: 28 }}>${D.fmt(amount + 320)}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4 }}>lifetime · estimated rank #142</div>
          </div>

          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 22 }}>
            Donate ${D.fmt(amount)} USDC
          </button>
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', textAlign: 'center', marginTop: 10 }}>
            Network fee ≈ $0.004 · Settles in &lt; 3s
          </div>
        </aside>
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, value, onChange }) {
  return (
    <div className="toggle-row">
      <div>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>{desc}</div>
      </div>
      <div className={'toggle' + (value ? ' on' : '')} onClick={() => onChange(!value)}></div>
    </div>
  );
}

// =============== Donor profile ===============
function DonorPage({ nav }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · You</div>
          <h1>Your donor profile</h1>
          <p className="sub muted">Connected as <span className="mono">0x9a3f…c21d</span></p>
        </div>
        <button className="btn btn-secondary"><Icon name="settings" size={14} /> Preferences</button>
      </div>

      <div className="dash-grid">
        <div className="col-4 card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Avatar name="haru.sui" color="oklch(0.6 0.08 145)" size={64} />
            <div>
              <h3>haru.sui</h3>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4 }}>Individual donor · since Mar 2026</div>
              <div style={{ marginTop: 8 }}><TierBadge tier="gold" /></div>
            </div>
          </div>
          <div className="divider"></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Mini label="Total donated" value="$89,400" />
            <Mini label="Donations" value="41" />
            <Mini label="Overall rank" value="#3" />
            <Mini label="Monthly rank" value="#1" />
          </div>
        </div>

        <div className="col-8 card">
          <h3>DonorPass</h3>
          <div className="muted" style={{ fontSize: 13, marginBottom: 20 }}>Your on-chain contribution receipt. Does not grant claim rights.</div>
          <div style={{ background: 'linear-gradient(135deg, var(--sage-700), var(--sage-500))', borderRadius: 'var(--radius-lg)', padding: 28, color: 'var(--cream-50)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', right: -40, top: -40, width: 200, height: 200, borderRadius: '50%', background: 'oklch(0.95 0.04 145 / 0.18)' }}></div>
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Sonari Donor Pass</div>
                  <div style={{ fontFamily: 'var(--font-serif)', fontSize: 38, marginTop: 16 }}>$89,400</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>lifetime contribution · 41 donations</div>
                </div>
                <span className="tier-badge tier-gold">Gold</span>
              </div>
              <div style={{ display: 'flex', gap: 20, marginTop: 28, fontSize: 12 }}>
                <div>
                  <div style={{ opacity: 0.7 }}>Pass ID</div>
                  <div className="mono" style={{ marginTop: 4 }}>pass_8d24…2a91</div>
                </div>
                <div>
                  <div style={{ opacity: 0.7 }}>Wallet</div>
                  <div className="mono" style={{ marginTop: 4 }}>0x9a3f…c21d</div>
                </div>
                <div>
                  <div style={{ opacity: 0.7 }}>Issued</div>
                  <div style={{ marginTop: 4 }}>Mar 14, 2026</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary"><Icon name="arrow-up-right" size={14} /> View on explorer</button>
            <button className="btn btn-ghost">Share publicly</button>
          </div>
        </div>

        <div className="col-12 card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3>Donation history</h3>
            <button className="btn btn-ghost btn-sm">Export CSV</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 120px 120px', padding: '12px 20px', background: 'var(--cream-50)', borderRadius: 'var(--radius-md) var(--radius-md) 0 0', border: '1px solid var(--line)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-faint)' }}>
            <div>Date</div>
            <div>Pool</div>
            <div>Tx</div>
            <div>Type</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
          </div>
          <div style={{ border: '1px solid var(--line)', borderTop: 'none', borderRadius: '0 0 var(--radius-md) var(--radius-md)' }}>
            {[
              { date: 'May 22, 2026', pool: 'Earthquake Pool', tx: '0x7f9c…1284', type: 'Designated', amount: 5000 },
              { date: 'May 18, 2026', pool: 'Earthquake Pool', tx: '0x2a44…8d22', type: 'Designated', amount: 12000 },
              { date: 'May 12, 2026', pool: 'Main Pool', tx: '0xab12…ff04', type: 'General', amount: 2500 },
              { date: 'May 04, 2026', pool: 'Operations', tx: '0x91ee…6c08', type: 'Operations', amount: 500 },
              { date: 'Apr 27, 2026', pool: 'Main Pool', tx: '0x3322…aa18', type: 'General', amount: 8000 },
            ].map((h, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 120px 120px', padding: '14px 20px', borderTop: i === 0 ? 'none' : '1px solid var(--line)', fontSize: 14, alignItems: 'center' }}>
                <div className="muted">{h.date}</div>
                <div>{h.pool}</div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{h.tx}</div>
                <div><Tag variant="neutral">{h.type}</Tag></div>
                <div style={{ textAlign: 'right' }} className="stat-num">{D.fmtUSD(h.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div className="stat-num" style={{ fontSize: 22, marginTop: 6 }}>{value}</div>
    </div>
  );
}

Object.assign(window, { DashboardPage, DonatePage, DonorPage, DisasterEventCard, Donut, Mini, ToggleRow });
