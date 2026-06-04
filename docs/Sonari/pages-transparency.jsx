// Claim, Events, Pools, Receipts pages

function ClaimPage({ nav }) {
  const [selected, setSelected] = useState(D.events[0]);
  const claimables = D.events.filter(e => e.status === 'finalized');
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Recipient</div>
          <h1>Claim relief</h1>
          <p className="sub muted">If your registered cell is affected by a finalized event, you're eligible to receive relief.</p>
        </div>
        <WalletButton />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
        <div>
          <div className="card" style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h3>Your status</h3>
              <Tag variant="ok" dot>Eligible</Tag>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>Membership Pass active · residence verified for cell <span className="mono">h3-8928308280fffff</span></p>
            <div className="divider"></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              <Mini label="Pass status" value="Active" />
              <Mini label="Verified cell" value="Tokyo" />
              <Mini label="Last refresh" value="2 days ago" />
            </div>
          </div>

          <div className="eyebrow" style={{ marginBottom: 14 }}>Claimable disaster events</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {claimables.map((e) => (
              <ClaimableEventCard key={e.id} event={e} selected={selected.id === e.id} onClick={() => setSelected(e)} />
            ))}
          </div>
        </div>

        <aside style={{ position: 'sticky', top: 90 }}>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Selected event</div>
            <h3 style={{ fontSize: 18 }}>{selected.region}</h3>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 4 }}>{selected.id}</div>

            <div className="divider"></div>

            <div className="eyebrow" style={{ marginBottom: 12 }}>Eligibility check</div>
            <div className="eligibility-list">
              <EligibilityItem label="Event is finalized" passed />
              <EligibilityItem label="Membership Pass is active" passed />
              <EligibilityItem label="Residence proof valid" passed />
              <EligibilityItem label="Your cell is in affected_cells" passed />
              <EligibilityItem label="Pool budget sufficient" passed />
              <EligibilityItem label="Not previously claimed" passed />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', marginTop: 22 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 6 }}>Estimated payout</div>
                <div className="stat-num" style={{ fontSize: 38 }}>$280</div>
                <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>USDC · settled to your wallet</div>
              </div>
            </div>

            <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 20 }}>
              <Icon name="heart" size={16} /> Claim relief
            </button>
            <div style={{ fontSize: 11, color: 'var(--ink-faint)', textAlign: 'center', marginTop: 10 }}>
              You'll receive an Impact Receipt referencing your hashed cell. No personal information is published.
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ClaimableEventCard({ event, selected, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)',
        border: selected ? '1.5px solid var(--sage-600)' : '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        padding: 22,
        display: 'grid',
        gridTemplateColumns: '80px 1fr auto',
        gap: 18,
        alignItems: 'center',
        cursor: 'pointer',
        transition: 'all 0.15s',
        boxShadow: selected ? '0 8px 24px oklch(0.5 0.06 145 / 0.10)' : 'none',
      }}
    >
      <div style={{ background: selected ? 'var(--sage-200)' : 'var(--sage-100)', borderRadius: 'var(--radius-md)', padding: 10, textAlign: 'center' }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--ink-faint)', letterSpacing: '0.08em' }}>Mag</div>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 24, color: 'var(--sage-800)', lineHeight: 1, marginTop: 4 }}>M{event.mag}</div>
      </div>
      <div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <Tag variant="ok" dot>Claimable</Tag>
          <Tag variant="info">{event.source}</Tag>
        </div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{event.region}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4 }}>{event.occurred} · window {event.window}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="stat-num" style={{ fontSize: 24 }}>$280</div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>your payout</div>
      </div>
    </div>
  );
}

function EligibilityItem({ label, passed }) {
  return (
    <div className={'eligibility-item' + (passed ? '' : ' pending')}>
      <div className="check-circle">{passed ? <Icon name="check" size={12} /> : '·'}</div>
      <div style={{ fontSize: 13 }}>{label}</div>
      <Tag variant={passed ? 'ok' : 'neutral'}>{passed ? 'Passed' : 'Pending'}</Tag>
    </div>
  );
}

// =============== Events page ===============
function EventsPage({ nav }) {
  const [filter, setFilter] = useState('all');
  const filtered = filter === 'all' ? D.events : D.events.filter(e => e.status === filter);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Transparency</div>
          <h1>Disaster events</h1>
          <p className="sub muted">All seismic events Sonari has observed — finalized, candidate, or expired.</p>
        </div>
      </div>

      <div className="filter-row">
        {['all', 'finalized', 'candidate', 'expired'].map((f) => (
          <button key={f} className={'filter-chip' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All events' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button className="filter-chip">USGS</button>
        <button className="filter-chip">JMA</button>
        <button className="filter-chip">Last 30 days</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filtered.map((e) => <DisasterEventCard key={e.id} event={e} onClick={() => {}} />)}
      </div>
    </div>
  );
}

function EventDetailInline({ event }) {
  // Used as a section, not a page right now — could be hooked in if we add routing depth
  return null;
}

// =============== Pools page ===============
function PoolsPage({ nav }) {
  const [selected, setSelected] = useState(D.pools[0]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Transparency</div>
          <h1>Pools</h1>
          <p className="sub muted">Where donations live before they're delivered, and where they go after.</p>
        </div>
      </div>

      <div className="pools-grid">
        {D.pools.map(p => (
          <div key={p.id} onClick={() => setSelected(p)} style={{ outline: selected.id === p.id ? '2px solid var(--sage-500)' : 'none', borderRadius: 'var(--radius-lg)' }}>
            <PoolCard pool={p} onClick={() => setSelected(p)} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 28, marginBottom: 18 }}>{selected.name}</h2>

        <div className="stats-grid" style={{ marginBottom: 24 }}>
          <StatCard label="Available balance" value={D.fmtUSD(selected.balance)} />
          <StatCard label="Total received" value={D.fmtUSD(selected.received)} />
          <StatCard label="Total delivered" value={D.fmtUSD(selected.paidOut)} />
          <StatCard label="Reserved" value={D.fmtUSD(selected.reserved)} meta="held for active campaigns" />
        </div>

        <div className="poolflow" style={{ marginBottom: 24 }}>
          <div className="poolflow-node">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Inflow · 30d</div>
            <div className="stat-num" style={{ fontSize: 26 }}>{D.fmtUSD(selected.received * 0.18)}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>248 donations from 162 wallets</div>
          </div>
          <div className="poolflow-arrow"><Icon name="arrow-right" size={22} /></div>
          <div className="poolflow-node" style={{ background: 'var(--sage-50)', border: '1px solid var(--sage-200)' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>{selected.name}</div>
            <div className="stat-num" style={{ fontSize: 26 }}>{D.fmtUSD(selected.balance)}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>available now</div>
          </div>
          <div className="poolflow-arrow"><Icon name="arrow-right" size={22} /></div>
          <div className="poolflow-node">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Delivered · 30d</div>
            <div className="stat-num" style={{ fontSize: 26 }}>{D.fmtUSD(selected.paidOut * 0.32)}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>421 receipts issued</div>
          </div>
        </div>

        <div className="dash-grid">
          <div className="col-6 card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3>Top donors to this pool</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => nav('leaderboard')}>View all <Icon name="arrow-right" size={12} /></button>
            </div>
            <div className="row-list">
              {D.donors.slice(0, 5).map((d, i) => <DonorRow key={i} d={d} idx={i} />)}
            </div>
          </div>

          <div className="col-6 card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3>Recent payouts</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => nav('receipts')}>All receipts <Icon name="arrow-right" size={12} /></button>
            </div>
            <div className="row-list">
              {D.receipts.slice(0, 5).map((r, i) => (
                <div className="row-item" key={i}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--sage-100)', display: 'grid', placeItems: 'center', color: 'var(--sage-700)' }}>
                    <Icon name="doc" size={16} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{r.program}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.id}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="stat-num" style={{ fontSize: 16 }}>{D.fmtUSD(r.amount)}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.when}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============== Receipts page ===============
function ReceiptsPage({ nav }) {
  const [selected, setSelected] = useState(D.receipts[0]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumb">Sonari · Transparency</div>
          <h1>Impact receipts</h1>
          <p className="sub muted">Every payout creates a public, anonymized receipt. The recipient stays private; the relief is provable.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 32, alignItems: 'start' }}>
        <div>
          <div className="filter-row">
            <button className="filter-chip active">All</button>
            <button className="filter-chip">Earthquake Relief</button>
            <button className="filter-chip">Community Aid</button>
            <button className="filter-chip">Last 7 days</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {D.receipts.map((r, i) => (
              <div
                key={i}
                className="receipt-card"
                onClick={() => setSelected(r)}
                style={{
                  cursor: 'pointer',
                  border: selected.id === r.id ? '1.5px solid var(--sage-600)' : '1px solid var(--line)',
                  background: selected.id === r.id ? 'var(--sage-50)' : 'var(--surface)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                    <Tag variant="ok" dot>Delivered</Tag>
                    <Tag variant="info">{r.pool === 'eq' ? 'Earthquake Pool' : 'Main Pool'}</Tag>
                  </div>
                  <div style={{ fontWeight: 600 }}>{r.program}</div>
                  <div className="mono receipt-id" style={{ marginTop: 4 }}>
                    {r.id} · {r.anon}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="stat-num" style={{ fontSize: 22 }}>{D.fmtUSD(r.amount)}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{r.when}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside style={{ position: 'sticky', top: 90 }}>
          <ReceiptDetailCard receipt={selected} />
        </aside>
      </div>
    </div>
  );
}

function ReceiptDetailCard({ receipt }) {
  return (
    <div className="card card-lg" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 180, height: 180, borderRadius: '50%', background: 'oklch(0.95 0.04 145)', opacity: 0.5 }}></div>
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <div className="eyebrow">Impact receipt</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8 }}>{receipt.id}</div>
          </div>
          <Tag variant="ok" dot>Delivered</Tag>
        </div>

        <div className="stat-num" style={{ fontSize: 52, marginTop: 24 }}>{D.fmtUSD(receipt.amount)}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 4 }}>USDC paid out · {receipt.when}</div>

        <div className="divider"></div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
          <DetailRow label="Program" value={receipt.program} />
          <DetailRow label="Source pool" value={receipt.pool === 'eq' ? 'Earthquake Relief Pool' : 'Main Pool'} />
          <DetailRow label="Disaster event" value={<span className="mono">{receipt.event}</span>} />
          <DetailRow label="Recipient ref" value={<span className="mono">{receipt.anon}</span>} />
          <DetailRow label="Tx digest" value={<span className="mono">0x4f22…aa18</span>} />
        </div>

        <div className="callout" style={{ marginTop: 22 }}>
          <Icon name="lock" size={16} />
          <div>
            Recipient identity, address, phone, and device info are <strong>not</strong> part of this receipt — only a hashed H3 cell reference.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button className="btn btn-secondary" style={{ flex: 1 }}><Icon name="arrow-up-right" size={14} /> Explorer</button>
          <button className="btn btn-ghost"><Icon name="doc" size={14} /> JSON</button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

Object.assign(window, { ClaimPage, EventsPage, PoolsPage, ReceiptsPage, ReceiptDetailCard, ClaimableEventCard, EligibilityItem, DetailRow });
