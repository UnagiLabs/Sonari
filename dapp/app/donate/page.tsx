import Image from "next/image";
import { WalletConnect } from "../wallet/wallet-connect";

type DonationType = {
    id: string;
    label: string;
    description: string;
    destination: string;
    defaultChecked?: boolean;
};

type PoolOption = {
    id: string;
    label: string;
    balance: string;
    detail: string;
    defaultChecked?: boolean;
};

type PreviewRow = {
    label: string;
    value: string;
    detail: string;
};

// Backend integration point: replace these values with wallet and pool data later.
const donationTypes: DonationType[] = [
    {
        id: "general",
        label: "General Donation",
        description: "Supports the main relief pool for future verified aid.",
        destination: "100% Main Pool",
        defaultChecked: true,
    },
    {
        id: "earthquake",
        label: "Earthquake Relief",
        description: "Directs most funds to the selected disaster relief pool.",
        destination: "80% Relief Pool / 20% Main Pool",
    },
];

const poolOptions: PoolOption[] = [
    {
        id: "main-pool",
        label: "Main Pool",
        balance: "$1.28M",
        detail: "Default public support pool",
        defaultChecked: true,
    },
    {
        id: "earthquake-pool",
        label: "Earthquake Relief Pool",
        balance: "$642K",
        detail: "Finalized disaster support",
    },
];

const splitPreview: PreviewRow[] = [
    { label: "Main Pool", value: "$80.00", detail: "Transparent reserve for verified aid" },
    { label: "Relief Pool", value: "$320.00", detail: "Selected earthquake relief campaign" },
];

const resultPreview = [
    { label: "DonationRecord", value: "Created after transaction confirmation" },
    { label: "DonorPass", value: "Issued or updated for this wallet" },
    { label: "Receipt", value: "Public impact receipt, recipient data anonymized" },
    { label: "Leaderboard", value: "Rank updates without claim rights or payout priority" },
];

export default function DonatePage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <DonateTopbar />

                <main className="page donate-page">
                    <header className="donate-hero">
                        <div>
                            <div className="eyebrow">Donate</div>
                            <h1>Send support with a clear trail.</h1>
                            <p className="muted donate-sub">
                                A front-end donation flow for USDC support, pool selection, public
                                display preferences, and receipt previews.
                            </p>
                        </div>
                        <div className="donate-wallet-panel">
                            <span className="tag tag-neutral">Wallet</span>
                            <p>Connect a wallet to prepare a donation transaction.</p>
                            <WalletConnect />
                        </div>
                    </header>

                    <section className="donate-layout" aria-label="Donation form preview">
                        <form className="donate-form" aria-labelledby="donation-form-title">
                            <div className="form-heading">
                                <div>
                                    <div className="eyebrow">Contribution</div>
                                    <h2 id="donation-form-title">Donation setup</h2>
                                </div>
                                <span className="tag tag-ok tag-dot">USDC</span>
                            </div>

                            <fieldset className="control-group">
                                <legend>Donation type</legend>
                                <div className="choice-grid">
                                    {donationTypes.map((type) => (
                                        <label className="choice-option" key={type.id}>
                                            <input
                                                defaultChecked={type.defaultChecked}
                                                name="donationType"
                                                type="radio"
                                                value={type.id}
                                            />
                                            <span>
                                                <strong>{type.label}</strong>
                                                <small>{type.description}</small>
                                                <em>{type.destination}</em>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>Pool</legend>
                                <div className="pool-select-list">
                                    {poolOptions.map((pool) => (
                                        <label className="pool-select-option" key={pool.id}>
                                            <input
                                                defaultChecked={pool.defaultChecked}
                                                name="pool"
                                                type="radio"
                                                value={pool.id}
                                            />
                                            <span>
                                                <strong>{pool.label}</strong>
                                                <small>{pool.detail}</small>
                                            </span>
                                            <b>{pool.balance}</b>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <div className="amount-field">
                                <label htmlFor="donation-amount">Amount</label>
                                <div className="amount-input-wrap">
                                    <input
                                        defaultValue="400"
                                        id="donation-amount"
                                        inputMode="decimal"
                                        name="amount"
                                        type="text"
                                    />
                                    <span>USDC</span>
                                </div>
                                <div className="quick-amounts">
                                    <button type="button">$50</button>
                                    <button type="button">$100</button>
                                    <button type="button">$250</button>
                                    <button type="button">$1,000</button>
                                </div>
                            </div>

                            <fieldset className="control-group">
                                <legend>Display preferences</legend>
                                <div className="toggle-list">
                                    <label className="toggle-row">
                                        <span>
                                            <strong>Public display name</strong>
                                            <small>
                                                Show a name on receipts and leaderboard previews.
                                            </small>
                                        </span>
                                        <input
                                            defaultChecked
                                            name="publicDisplay"
                                            type="checkbox"
                                        />
                                    </label>
                                    <label className="toggle-row">
                                        <span>
                                            <strong>Anonymous mode</strong>
                                            <small>Use Anonymous Donor in public lists.</small>
                                        </span>
                                        <input name="anonymous" type="checkbox" />
                                    </label>
                                    <label className="toggle-row">
                                        <span>
                                            <strong>Corporate sponsor mode</strong>
                                            <small>
                                                Prepare sponsor logo and profile fields later.
                                            </small>
                                        </span>
                                        <input name="corporateMode" type="checkbox" />
                                    </label>
                                </div>
                            </fieldset>

                            <div className="form-actions">
                                <button className="btn btn-primary btn-lg" type="button">
                                    Donate preview
                                </button>
                                <button className="btn btn-secondary btn-lg" type="button">
                                    Save draft
                                </button>
                            </div>
                        </form>

                        <aside className="donate-side" aria-label="Donation preview">
                            <section className="preview-block">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">Split preview</div>
                                        <h2>Estimated allocation</h2>
                                    </div>
                                    <span className="stat-num">$400</span>
                                </div>
                                <div className="split-list">
                                    {splitPreview.map((row) => (
                                        <div className="split-row" key={row.label}>
                                            <div>
                                                <strong>{row.label}</strong>
                                                <small>{row.detail}</small>
                                            </div>
                                            <span>{row.value}</span>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="preview-block">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">After donation</div>
                                        <h2>Result preview</h2>
                                    </div>
                                </div>
                                <div className="result-list">
                                    {resultPreview.map((item) => (
                                        <div className="result-row" key={item.label}>
                                            <span className="result-dot" />
                                            <div>
                                                <strong>{item.label}</strong>
                                                <small>{item.value}</small>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="donate-note">
                                <h3>DonorPass note</h3>
                                <p>
                                    DonorPass records contribution history only. It does not provide
                                    claim rights, payout priority, or promised aid.
                                </p>
                                <a className="text-action" href="/dashboard">
                                    View dashboard
                                </a>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}

function DonateTopbar() {
    return (
        <header className="topbar">
            <div className="topbar-inner">
                <a className="brand" href="/" aria-label="Sonari home">
                    <span className="brand-mark">
                        <Image
                            src="/assets/sonari_logo.png"
                            alt="Sonari"
                            width={36}
                            height={36}
                            priority
                        />
                    </span>
                    <span className="brand-name">Sonari</span>
                </a>
                <nav className="nav" aria-label="Primary">
                    <a className="nav-item" href="/">
                        Home
                    </a>
                    <a className="nav-item active" href="/donate">
                        Donate
                    </a>
                    <a className="nav-item" href="/dashboard">
                        Dashboard
                    </a>
                    <a className="nav-item" href="/leaderboard">
                        Leaderboard
                    </a>
                    <a className="nav-item" href="/claim">
                        Claim
                    </a>
                </nav>
                <div className="topbar-spacer" />
                <WalletConnect />
            </div>
        </header>
    );
}
