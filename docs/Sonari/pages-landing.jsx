// Landing page
function LandingPage({ nav }) {
  const stats = D.impactStats;
  return (
    <div className="page" style={{ paddingTop: 0 }}>
      {/* Hero */}
      <section className="hero">
        <div className="hero-grid">
          <div>
            <div className="hero-eyebrow">
              <Icon name="sprout" size={14} />
              Transparent donation infrastructure
            </div>
            <h1>
              Donations that <span className="alt">arrive</span><br/>
              where they're needed.
            </h1>
            <p className="hero-sub">
              Sonari verifies who should receive aid after a disaster — using
              public seismic data, hashed residence proofs, and on-chain receipts.
              Every donation is traceable. Every payout is witnessed.
            </p>
            <div className="hero-ctas">
              <button className="btn btn-primary btn-lg" onClick={() => nav('donate')}>
                <Icon name="heart" size={16} /> Donate now
              </button>
              <button className="btn btn-secondary btn-lg" onClick={() => nav('claim')}>
                Claim relief <Icon name="arrow-right" size={16} />
              </button>
              <button className="btn btn-ghost btn-lg" onClick={() => nav('dashboard')}>
                View dashboard
              </button>
            </div>
            <div style={{ marginTop: 28, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--ink-muted)' }}>
                <Icon name="lock" size={14} /> Residence data never leaves your device
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--ink-muted)' }}>
                <Icon name="verified" size={14} /> TEE-verified disaster events
              </div>
            </div>
          </div>

          <div className="hero-illustration">
            <img src="assets/sonari_logo.png" alt="Sonari" style={{ width: '72%' }} />
          </div>
        </div>

        {/* Hero stats row */}
        <div style={{ marginTop: 56 }}>
          <div className="stats-grid">
            <StatCard label="Total donated" value={D.fmtUSD(stats.totalDonated)} meta={<><span style={{ color: 'var(--ok)' }}>↑ $48,200</span> in 24h</>} />
            <StatCard label="Total relief delivered" value={D.fmtUSD(stats.totalPaidOut)} meta={<>across {D.fmt(stats.verifiedClaims)} verified claims</>} />
            <StatCard label="Active pools" value={stats.activePools} meta="Main · Earthquake" />
            <StatCard label="Verified events" value="14" meta="from USGS &amp; JMA · last 90 days" />
          </div>
        </div>
      </section>

      {/* Sponsor marquee */}
      <section style={{ padding: '40px 0 12px' }}>
        <div className="eyebrow" style={{ textAlign: 'center', marginBottom: 22 }}>Supported by transparent partners</div>
        <SponsorMarquee />
      </section>

      {/* How Sonari works */}
      <section className="section">
        <SectionHeader
          eyebrow="How Sonari works"
          title="Four steps from donation to relief."
          sub="No hidden discretion. No promises of compensation. Just verifiable steps anyone can audit."
        />
        <div className="steps">
          <Step n="01" title="Donate in USDC" body="Choose a pool. Donations are recorded on-chain with a DonorPass — your contribution history, not a claim right." />
          <Step n="02" title="Disaster verified" body="USGS or JMA reports a seismic event. A TEE re-fetches the source and signs the payload only if it matches." />
          <Step n="03" title="Eligibility checked" body="Recipients with an active MembershipPass and a residence proof inside the affected H3 cells become claimable." />
          <Step n="04" title="Relief, with a receipt" body="Each payout creates an anonymized Impact Receipt — public, traceable, with no personal information exposed." />
        </div>
      </section>

      {/* Featured pools */}
      <section className="section">
        <SectionHeader
          eyebrow="Featured pools"
          title="See where each dollar lives."
          action={<button className="btn btn-ghost" onClick={() => nav('pools')}>All pools <Icon name="arrow-right" size={14} /></button>}
        />
        <div className="pools-grid">
          {D.pools.map((p) => <PoolCard key={p.id} pool={p} onClick={() => nav('pools')} />)}
        </div>
      </section>

      {/* Top supporters preview */}
      <section className="section">
        <SectionHeader
          eyebrow="Top supporters"
          title="The people and partners keeping the reserve full."
          action={<button className="btn btn-ghost" onClick={() => nav('leaderboard')}>Full leaderboard <Icon name="arrow-right" size={14} /></button>}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3>Top individual donors</h3>
              <Tag variant="neutral">This month</Tag>
            </div>
            <div className="row-list" style={{ marginTop: 12 }}>
              {D.donors.filter(d => d.type === 'individual').slice(0, 3).map((d, i) => <DonorRow key={i} d={d} idx={i} />)}
            </div>
          </div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3>Top corporate sponsors</h3>
              <Tag variant="neutral">All time</Tag>
            </div>
            <div className="row-list" style={{ marginTop: 12 }}>
              {D.donors.filter(d => d.type === 'corporate').slice(0, 3).map((d, i) => <DonorRow key={i} d={d} idx={i} />)}
            </div>
          </div>
        </div>
      </section>

      {/* Why Sonari */}
      <section className="section">
        <SectionHeader
          eyebrow="Why Sonari"
          title="Donation infrastructure, not a payout promise."
        />
        <div className="value-grid">
          <ValueProp icon="eye" title="Witnessable, end to end" body="Every donation, eligibility check, and payout writes a receipt to a public ledger. You don't have to trust us — you can read it." />
          <ValueProp icon="lock" title="Recipient-private by design" body="Raw addresses, phones, and GPS never touch the chain. We publish only the hashed H3 cell that proves residence at the time of registration." />
          <ValueProp icon="shield" title="Three checkpoints before a payout" body="A finalized seismic event, an active MembershipPass, and a valid residence proof. No discretionary approval. No queue jumping." />
        </div>
      </section>

      {/* Trust banner */}
      <section className="section">
        <div className="trust-banner">
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Important to know</div>
            <h2 style={{ fontSize: 32 }}>Sonari is a donation network, not insurance.</h2>
            <p className="muted" style={{ marginTop: 16, fontSize: 15, maxWidth: 520 }}>
              Donating does not buy a claim right. Receiving relief depends only on
              your verified residence at the time of a finalized disaster event.
              The DonorPass records contribution history — nothing more.
            </p>
          </div>
          <div className="trust-list">
            <TrustItem text="No premiums. No deductibles. No coverage agreements." />
            <TrustItem text="Top donors get no payout priority and no claim rights." />
            <TrustItem text="All discretionary controls (pause, oracle) are public." />
            <TrustItem text="Sponsor logos require manual verification and approval." />
          </div>
        </div>
      </section>
    </div>
  );
}

function Step({ n, title, body }) {
  return (
    <div className="step">
      <div className="step-num">{n}</div>
      <h4>{title}</h4>
      <p>{body}</p>
    </div>
  );
}

function ValueProp({ icon, title, body }) {
  return (
    <div className="value">
      <div className="icon-wrap"><Icon name={icon} size={22} /></div>
      <h4>{title}</h4>
      <p>{body}</p>
    </div>
  );
}

function TrustItem({ text }) {
  return (
    <div className="trust-list-item">
      <div className="check"><Icon name="check" size={13} /></div>
      <span style={{ fontSize: 14, color: 'var(--sage-900)' }}>{text}</span>
    </div>
  );
}

function PoolCard({ pool, onClick }) {
  const iconName = pool.type === 'main' ? 'waves' : pool.type === 'earthquake' ? 'bolt' : 'settings';
  const pct = Math.round(pool.balance / pool.received * 100);
  return (
    <div className="pool-card" onClick={onClick}>
      <div className="header">
        <div className="icon"><Icon name={iconName} size={20} /></div>
        <Tag variant="ok" dot>active</Tag>
      </div>
      <div>
        <h3>{pool.name}</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>{pool.desc}</p>
      </div>
      <div>
        <div className="balance">{D.fmtUSD(pool.balance)}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 6 }}>available balance</div>
      </div>
      <div>
        <div className="meter"><div className="meter-fill" style={{ width: pct + '%' }}></div></div>
        <div className="footer-row" style={{ marginTop: 10 }}>
          <span>{D.fmtUSD(pool.received)} received</span>
          <span>{D.fmtUSD(pool.paidOut)} delivered</span>
        </div>
      </div>
    </div>
  );
}

function SponsorMarquee() {
  const row1 = D.sponsors.slice(0, 6);
  const row2 = D.sponsors.slice(6, 12);
  const renderRow = (sponsors, reverse) => {
    const items = [...sponsors, ...sponsors]; // duplicate for seamless loop
    return (
      <div className="marquee-wrap">
        <div className={'marquee' + (reverse ? ' reverse' : '')}>
          {items.map((s, i) => (
            <div className="marquee-item" key={i}>
              <div className="logo-square" style={{ background: s.color }}>{s.logo}</div>
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {renderRow(row1, false)}
      {renderRow(row2, true)}
    </div>
  );
}

Object.assign(window, { LandingPage, PoolCard, SponsorMarquee, Step, TrustItem, ValueProp });
