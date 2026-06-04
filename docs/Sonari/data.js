// Sonari mock data
window.SonariData = (() => {
  const fmt = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
  const fmtUSD = (n) => '$' + fmt(n);
  const short = (addr) => addr.slice(0, 6) + '…' + addr.slice(-4);

  const sponsors = [
    { name: 'Aizome Foundation',   logo: 'AF', color: 'oklch(0.55 0.06 145)' },
    { name: 'Kibou Capital',       logo: 'KC', color: 'oklch(0.58 0.07 120)' },
    { name: 'Midori Logistics',    logo: 'ML', color: 'oklch(0.5  0.05 170)' },
    { name: 'Hinode Bank',         logo: 'HB', color: 'oklch(0.6  0.07 50)'  },
    { name: 'Tsuyu Insurance Co.', logo: 'TI', color: 'oklch(0.55 0.05 200)' },
    { name: 'Sora Networks',       logo: 'SN', color: 'oklch(0.5  0.06 230)' },
    { name: 'Kogane Energy',       logo: 'KE', color: 'oklch(0.62 0.08 80)'  },
    { name: 'Yume Robotics',       logo: 'YR', color: 'oklch(0.5  0.06 290)' },
    { name: 'Hana Pharmaceuticals',logo: 'HP', color: 'oklch(0.6  0.06 10)'  },
    { name: 'Niji Studios',        logo: 'NS', color: 'oklch(0.58 0.07 300)' },
    { name: 'Kawa Mobility',       logo: 'KM', color: 'oklch(0.5  0.05 180)' },
    { name: 'Tomoshibi Co-op',     logo: 'TC', color: 'oklch(0.55 0.06 140)' },
  ];

  const tiers = ['bronze', 'silver', 'gold'];
  const avatarColors = [
    'oklch(0.65 0.08 145)', 'oklch(0.6 0.08 75)', 'oklch(0.6 0.08 230)',
    'oklch(0.6 0.08 25)', 'oklch(0.65 0.07 290)', 'oklch(0.55 0.08 165)',
    'oklch(0.6 0.08 50)', 'oklch(0.55 0.07 200)', 'oklch(0.6 0.07 100)',
  ];

  const donors = [
    { rank: 1, name: 'Aizome Foundation', type: 'corporate', tier: 'gold', total: 524800, count: 84, pools: ['Main', 'Earthquake'], when: '2h ago' },
    { rank: 2, name: 'Kibou Capital',     type: 'corporate', tier: 'gold', total: 412300, count: 62, pools: ['Main', 'Earthquake', 'Ops'], when: '5h ago' },
    { rank: 3, name: 'haru.sui',          type: 'individual', tier: 'gold', total: 89400, count: 41, pools: ['Earthquake'], when: '1h ago' },
    { rank: 4, name: 'Midori Logistics',  type: 'corporate', tier: 'gold', total: 76250, count: 28, pools: ['Main', 'Earthquake'], when: '12h ago' },
    { rank: 5, name: 'Anonymous Donor',   type: 'individual', tier: 'silver', total: 52100, count: 19, anon: true, pools: ['Main'], when: '3h ago' },
    { rank: 6, name: 'Hinode Bank',       type: 'corporate', tier: 'silver', total: 48900, count: 36, pools: ['Main'], when: '2d ago' },
    { rank: 7, name: 'matcha_dev',        type: 'individual', tier: 'silver', total: 34200, count: 52, pools: ['Earthquake', 'Ops'], when: '4h ago' },
    { rank: 8, name: 'Tsuyu Insurance',   type: 'corporate', tier: 'silver', total: 28750, count: 15, pools: ['Main'], when: '1d ago' },
    { rank: 9, name: 'sakura.eth',        type: 'individual', tier: 'silver', total: 21800, count: 33, pools: ['Earthquake'], when: '8h ago' },
    { rank: 10, name: 'Anonymous Donor',  type: 'individual', tier: 'bronze', total: 18200, count: 11, anon: true, pools: ['Main'], when: '6h ago' },
    { rank: 11, name: 'Sora Networks',    type: 'corporate', tier: 'bronze', total: 16400, count: 24, pools: ['Main', 'Ops'], when: '3d ago' },
    { rank: 12, name: 'tsuki_kawa',       type: 'individual', tier: 'bronze', total: 14250, count: 22, pools: ['Earthquake'], when: '1d ago' },
  ];

  const pools = [
    { id: 'main', name: 'Main Pool', type: 'main', balance: 1284000, received: 2104000, paidOut: 820000, reserved: 124000, status: 'active', desc: 'General relief reserves across all programs.' },
    { id: 'eq',   name: 'Earthquake Relief Pool', type: 'earthquake', balance: 642800, received: 980200, paidOut: 337400, reserved: 88500, status: 'active', desc: 'Reserved for finalized earthquake events.' },
    { id: 'ops',  name: 'Operations Pool', type: 'operations', balance: 96400, received: 142600, paidOut: 46200, reserved: 12000, status: 'active', desc: 'Funds infrastructure, oracle, and audits.' },
  ];

  const events = [
    { id: 'jma-2026-0521-184', source: 'JMA',  status: 'finalized', mag: 6.8,  jma: '6-', region: 'Off Iwate Pref., Japan',  occurred: 'May 21, 2026 — 04:32 JST', cells: 1284, window: 'until Jun 04', claims: 412 },
    { id: 'usgs-2026-0517-021', source: 'USGS', status: 'finalized', mag: 7.1, mmi: 'VIII', region: 'Davao Region, Philippines', occurred: 'May 17, 2026 — 22:08 PHT', cells: 2160, window: 'until May 31', claims: 783 },
    { id: 'jma-2026-0502-097', source: 'JMA',  status: 'expired',   mag: 5.4,  jma: '5-', region: 'Ibaraki Pref., Japan',     occurred: 'May 02, 2026 — 14:11 JST', cells: 412,  window: 'closed', claims: 96 },
    { id: 'usgs-2026-0426-340', source: 'USGS', status: 'candidate', mag: 5.9, mmi: 'VI',  region: 'East of Taiwan',          occurred: 'Apr 26, 2026 — 06:42 TST', cells: 280, window: 'verifying', claims: 0 },
  ];

  const receipts = [
    { id: 'rcp_8d2e91', amount: 280, program: 'Earthquake Relief', event: 'jma-2026-0521-184', pool: 'eq', when: '12 min ago', anon: 'recipient · h3-xQzm' },
    { id: 'rcp_8d2e90', amount: 280, program: 'Earthquake Relief', event: 'jma-2026-0521-184', pool: 'eq', when: '18 min ago', anon: 'recipient · h3-aBcd' },
    { id: 'rcp_8d2e8f', amount: 200, program: 'Earthquake Relief', event: 'usgs-2026-0517-021', pool: 'main', when: '42 min ago', anon: 'recipient · h3-9P1q' },
    { id: 'rcp_8d2e8e', amount: 200, program: 'Earthquake Relief', event: 'usgs-2026-0517-021', pool: 'main', when: '1h ago', anon: 'recipient · h3-Lk22' },
    { id: 'rcp_8d2e8d', amount: 280, program: 'Earthquake Relief', event: 'jma-2026-0521-184', pool: 'eq', when: '2h ago', anon: 'recipient · h3-vN8r' },
    { id: 'rcp_8d2e8c', amount: 280, program: 'Earthquake Relief', event: 'jma-2026-0521-184', pool: 'eq', when: '3h ago', anon: 'recipient · h3-Mc4f' },
  ];

  const recentDonations = [
    { who: 'Aizome Foundation', type: 'corporate', amount: 25000, pool: 'Earthquake', when: '4 min ago' },
    { who: 'haru.sui',          type: 'individual', amount: 1200, pool: 'Earthquake', when: '11 min ago' },
    { who: 'Anonymous Donor',   type: 'individual', amount: 80, pool: 'Main', when: '18 min ago', anon: true },
    { who: 'matcha_dev',        type: 'individual', amount: 240, pool: 'Ops', when: '24 min ago' },
    { who: 'Kibou Capital',     type: 'corporate', amount: 12000, pool: 'Main', when: '38 min ago' },
    { who: 'sakura.eth',        type: 'individual', amount: 65, pool: 'Earthquake', when: '52 min ago' },
  ];

  return {
    fmt, fmtUSD, short,
    sponsors, donors, pools, events, receipts, recentDonations, tiers, avatarColors,
    impactStats: {
      totalDonated: 3226800,
      totalPaidOut: 1203600,
      activePools: 3,
      verifiedClaims: 1291,
    },
  };
})();
