// Sonari main app — top navigation and page routing

const NAV_GROUPS = [
  {
    label: 'Public',
    items: [
      { id: 'landing',    label: 'Home' },
      { id: 'donate',     label: 'Donate' },
      { id: 'dashboard',  label: 'Dashboard' },
      { id: 'leaderboard',label: 'Leaderboard' },
      { id: 'sponsors',   label: 'Sponsors' },
    ],
  },
  {
    label: 'You',
    items: [
      { id: 'donor',     label: 'Profile' },
      { id: 'register',  label: 'Register' },
      { id: 'claim',     label: 'Claim' },
    ],
  },
  {
    label: 'Transparency',
    items: [
      { id: 'events',    label: 'Events' },
      { id: 'pools',     label: 'Pools' },
      { id: 'receipts',  label: 'Receipts' },
    ],
  },
];

const PAGES = {
  landing:     LandingPage,
  dashboard:   DashboardPage,
  donate:      DonatePage,
  donor:       DonorPage,
  leaderboard: LeaderboardPage,
  sponsors:    SponsorsPage,
  register:    RegisterPage,
  claim:       ClaimPage,
  events:      EventsPage,
  pools:       PoolsPage,
  receipts:    ReceiptsPage,
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "sage",
  "fontHeading": "Instrument Serif",
  "showWatercolor": true,
  "density": "comfortable"
}/*EDITMODE-END*/;

const PALETTES = {
  sage:    { name: 'Sage (default)', hue: 145, chroma: 0.045, sandHue: 75 },
  ocean:   { name: 'Ocean',          hue: 210, chroma: 0.05,  sandHue: 60 },
  sakura:  { name: 'Sakura',         hue: 25,  chroma: 0.045, sandHue: 320 },
  charcoal:{ name: 'Charcoal',       hue: 145, chroma: 0.015, sandHue: 60 },
};

function applyPalette(key) {
  const p = PALETTES[key] || PALETTES.sage;
  const root = document.documentElement;
  const setSage = (token, L) => root.style.setProperty(`--sage-${token}`, `oklch(${L} ${p.chroma} ${p.hue})`);
  setSage(50,  0.98);
  setSage(100, 0.95);
  setSage(200, 0.90);
  setSage(300, 0.82);
  setSage(400, 0.72);
  setSage(500, 0.60);
  setSage(600, 0.50);
  setSage(700, 0.40);
  setSage(800, 0.30);
  setSage(900, 0.22);
  root.style.setProperty('--sand-300', `oklch(0.85 0.035 ${p.sandHue})`);
  root.style.setProperty('--sand-500', `oklch(0.72 0.06 ${p.sandHue})`);
  root.style.setProperty('--sand-700', `oklch(0.50 0.05 ${p.sandHue})`);
  if (key === 'charcoal') {
    root.style.setProperty('--ink',       'oklch(0.18 0.015 145)');
    root.style.setProperty('--ink-muted', 'oklch(0.45 0.01 145)');
  } else {
    root.style.setProperty('--ink',       `oklch(0.25 0.02 ${p.hue})`);
    root.style.setProperty('--ink-muted', `oklch(0.50 0.015 ${p.hue})`);
  }
}

const FONT_HEAD_MAP = {
  'Instrument Serif': '"Instrument Serif", Georgia, serif',
  'Plus Jakarta Sans': '"Plus Jakarta Sans", sans-serif',
  'Cormorant Garamond': '"Cormorant Garamond", Georgia, serif',
  'Manrope': '"Manrope", sans-serif',
};

function App() {
  const [page, setPage] = useState('landing');
  const tweaks = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => { applyPalette(tweaks.palette); }, [tweaks.palette]);
  useEffect(() => {
    document.documentElement.style.setProperty('--font-serif', FONT_HEAD_MAP[tweaks.fontHeading] || FONT_HEAD_MAP['Instrument Serif']);
  }, [tweaks.fontHeading]);

  const nav = (id) => { setPage(id); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const PageComp = PAGES[page] || LandingPage;

  return (
    <div className="app" data-density={tweaks.density}>
      {tweaks.showWatercolor && <div className="watercolor-bg"></div>}

      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand" onClick={() => nav('landing')}>
            <BrandMark size={36} />
            <span className="brand-name">Sonari</span>
          </div>
          <nav className="nav">
            {NAV_GROUPS.map((g) => (
              <React.Fragment key={g.label}>
                <span className="nav-group-label">{g.label}</span>
                {g.items.map((item) => (
                  <button
                    key={item.id}
                    className={'nav-item' + (page === item.id ? ' active' : '')}
                    onClick={() => nav(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>
          <div className="topbar-spacer"></div>
          <WalletButton />
        </div>
      </header>

      <main data-screen-label={page}>
        <PageComp nav={nav} />
      </main>

      <SonariFooter nav={nav} />

      <TweaksPanel title="Tweaks">
        <TweakSection title="Palette">
          <TweakRadio
            label="Theme"
            value={tweaks.palette}
            onChange={(v) => tweaks.setTweak('palette', v)}
            options={[
              { value: 'sage', label: 'Sage' },
              { value: 'ocean', label: 'Ocean' },
              { value: 'sakura', label: 'Sakura' },
              { value: 'charcoal', label: 'Mono' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Typography">
          <TweakSelect
            label="Heading font"
            value={tweaks.fontHeading}
            onChange={(v) => tweaks.setTweak('fontHeading', v)}
            options={[
              { value: 'Instrument Serif', label: 'Instrument Serif' },
              { value: 'Cormorant Garamond', label: 'Cormorant Garamond' },
              { value: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans' },
              { value: 'Manrope', label: 'Manrope' },
            ]}
          />
        </TweakSection>

        <TweakSection title="Atmosphere">
          <TweakToggle
            label="Watercolor backdrop"
            value={tweaks.showWatercolor}
            onChange={(v) => tweaks.setTweak('showWatercolor', v)}
          />
        </TweakSection>

        <TweakSection title="Quick navigate">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {Object.keys(PAGES).map((p) => (
              <button
                key={p}
                onClick={() => nav(p)}
                style={{
                  padding: '8px 10px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: page === p ? 'var(--sage-200)' : 'var(--surface)',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function SonariFooter({ nav }) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 18 }}>
            <BrandMark size={40} />
            <div className="brand-name" style={{ fontSize: 28 }}>Sonari</div>
          </div>
          <p className="muted" style={{ fontSize: 14, maxWidth: 360 }}>
            Transparent donation infrastructure that verifies who should receive aid. Built for clarity, not for compensation.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <Tag variant="ok" dot>Mainnet · live</Tag>
            <Tag variant="neutral">Sui</Tag>
          </div>
        </div>
        <div className="footer-col">
          <h5>Give</h5>
          <a onClick={() => nav('donate')}>Donate</a>
          <a onClick={() => nav('leaderboard')}>Leaderboard</a>
          <a onClick={() => nav('sponsors')}>Sponsors</a>
          <a onClick={() => nav('donor')}>Your profile</a>
        </div>
        <div className="footer-col">
          <h5>Receive</h5>
          <a onClick={() => nav('register')}>Register</a>
          <a onClick={() => nav('claim')}>Claim relief</a>
          <a onClick={() => nav('events')}>Events</a>
        </div>
        <div className="footer-col">
          <h5>Transparency</h5>
          <a onClick={() => nav('pools')}>Pools</a>
          <a onClick={() => nav('receipts')}>Receipts</a>
          <a onClick={() => nav('dashboard')}>Dashboard</a>
        </div>
      </div>
      <div className="footer-bottom">
        <div>© 2026 Sonari — Not insurance. Not a compensation guarantee.</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <span>Privacy</span>
          <span>Terms</span>
          <span>Audit</span>
        </div>
      </div>
    </footer>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
