import Image from "next/image";

type ClaimableEvent = {
    id: string;
    source: "USGS";
    region: string;
    intensity: string;
    affectedCells: string;
    window: string;
    defaultChecked?: boolean;
};

type EligibilityCheck = {
    label: string;
    detail: string;
    status: "ready" | "pending";
};

// Backend integration point: replace these values with wallet, pass, and event data later.
const membershipPass = {
    status: "Active",
    passId: "pass_0x7a9...21c",
    residenceCell: "h3-8a30a10cfffffff",
    verification: "Signed residence metadata valid",
};

const claimableEvents: ClaimableEvent[] = [
    {
        id: "usgs-2026-0521-184",
        source: "USGS",
        region: "Offshore Iwate, Japan",
        intensity: "M6.8 / MMI VIII",
        affectedCells: "1,284 affected cells",
        window: "Open until Jun 04",
        defaultChecked: true,
    },
    {
        id: "usgs-2026-0517-021",
        source: "USGS",
        region: "Northern California",
        intensity: "M5.9 / MMI VII",
        affectedCells: "482 affected cells",
        window: "Open until Jun 01",
    },
];

const eligibilityChecks: EligibilityCheck[] = [
    {
        label: "DisasterEvent finalized",
        detail: "Signed payload has been accepted by the program.",
        status: "ready",
    },
    {
        label: "MembershipPass active",
        detail: "Connected wallet has a current MembershipPass.",
        status: "ready",
    },
    {
        label: "Residence cell included",
        detail: "Registered H3 cell appears in affected_cells.",
        status: "ready",
    },
    {
        label: "No previous claim",
        detail: "This event has not been claimed by this pass.",
        status: "ready",
    },
    {
        label: "Pool budget available",
        detail: "Relief pool has enough available amount for the estimate.",
        status: "pending",
    },
];

const claimPreview = [
    { label: "Estimated Relief Cash", value: "$280 USDC" },
    { label: "Pool source", value: "Earthquake Relief Pool" },
    { label: "Campaign", value: "USGS Earthquake Relief" },
    { label: "Receipt", value: "Public, recipient reference anonymized" },
];

export default function ClaimPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <ClaimTopbar />

                <main className="page claim-page">
                    <header className="claim-hero">
                        <div>
                            <div className="eyebrow">Claim relief</div>
                            <h1>Check eligibility without exposing private details.</h1>
                            <p className="muted claim-sub">
                                A front-end claim flow for MembershipPass status, finalized disaster
                                events, eligibility checks, and Relief Cash transaction previews.
                            </p>
                        </div>
                        <div className="claim-wallet-panel">
                            <span className="tag tag-neutral">Wallet</span>
                            <p>Connect a wallet to load MembershipPass and claim history.</p>
                            <button className="btn btn-primary" type="button">
                                Connect wallet
                            </button>
                        </div>
                    </header>

                    <section className="claim-layout" aria-label="Claim flow preview">
                        <div className="claim-main">
                            <section className="claim-pass-panel" aria-labelledby="pass-title">
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">MembershipPass</div>
                                        <h2 id="pass-title">Recipient status</h2>
                                    </div>
                                    <span className="tag tag-ok tag-dot">
                                        {membershipPass.status}
                                    </span>
                                </div>
                                <dl className="pass-grid">
                                    <div>
                                        <dt>Pass ID</dt>
                                        <dd>{membershipPass.passId}</dd>
                                    </div>
                                    <div>
                                        <dt>Residence cell</dt>
                                        <dd>{membershipPass.residenceCell}</dd>
                                    </div>
                                    <div>
                                        <dt>Verification</dt>
                                        <dd>{membershipPass.verification}</dd>
                                    </div>
                                </dl>
                            </section>

                            <section
                                className="claim-event-panel"
                                aria-labelledby="event-select-title"
                            >
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">DisasterEvent</div>
                                        <h2 id="event-select-title">Claimable events</h2>
                                    </div>
                                    <a className="text-action" href="/events">
                                        View events
                                    </a>
                                </div>

                                <fieldset className="control-group">
                                    <legend>Select event</legend>
                                    <div className="claim-event-list">
                                        {claimableEvents.map((event) => (
                                            <label className="claim-event-option" key={event.id}>
                                                <input
                                                    defaultChecked={event.defaultChecked}
                                                    name="claimEvent"
                                                    type="radio"
                                                    value={event.id}
                                                />
                                                <span className="event-badge">{event.source}</span>
                                                <span>
                                                    <strong>{event.region}</strong>
                                                    <small>{event.id}</small>
                                                </span>
                                                <span>
                                                    <b>{event.intensity}</b>
                                                    <small>{event.affectedCells}</small>
                                                </span>
                                                <em>{event.window}</em>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>
                            </section>

                            <section
                                className="claim-check-panel"
                                aria-labelledby="eligibility-title"
                            >
                                <div className="panel-header">
                                    <div>
                                        <div className="eyebrow">Eligibility</div>
                                        <h2 id="eligibility-title">Verification checks</h2>
                                    </div>
                                    <button className="btn btn-secondary" type="button">
                                        Check eligibility
                                    </button>
                                </div>
                                <div className="check-list">
                                    {eligibilityChecks.map((check) => (
                                        <div className="check-row" key={check.label}>
                                            <span
                                                className={`check-indicator ${
                                                    check.status === "ready" ? "ready" : "pending"
                                                }`}
                                            />
                                            <div>
                                                <strong>{check.label}</strong>
                                                <small>{check.detail}</small>
                                            </div>
                                            <span className="tag tag-neutral">{check.status}</span>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        </div>

                        <aside className="claim-side" aria-label="Claim preview">
                            <section className="claim-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">Preview</div>
                                        <h2>Estimated claim</h2>
                                    </div>
                                </div>
                                <div className="claim-preview-list">
                                    {claimPreview.map((item) => (
                                        <div className="claim-preview-row" key={item.label}>
                                            <span>{item.label}</span>
                                            <strong>{item.value}</strong>
                                        </div>
                                    ))}
                                </div>
                                <button className="btn btn-primary btn-lg" type="button">
                                    Claim relief preview
                                </button>
                            </section>

                            <section className="claim-note">
                                <h3>Privacy boundary</h3>
                                <p>
                                    Public screens should show H3 cell, pass status, verification
                                    status, and anonymized recipient references only.
                                </p>
                            </section>

                            <section className="claim-result-panel">
                                <div className="eyebrow">Transaction result</div>
                                <div className="result-placeholder">
                                    <strong>Waiting for claim action</strong>
                                    <small>
                                        The transaction digest, receipt link, and status can be
                                        rendered here after backend integration.
                                    </small>
                                </div>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}

function ClaimTopbar() {
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
                    <a className="nav-item" href="/donate">
                        Donate
                    </a>
                    <a className="nav-item" href="/dashboard">
                        Dashboard
                    </a>
                    <a className="nav-item" href="/leaderboard">
                        Leaderboard
                    </a>
                    <a className="nav-item active" href="/claim">
                        Claim
                    </a>
                </nav>
                <div className="topbar-spacer" />
                <button className="wallet-btn" type="button">
                    <span className="wallet-dot" />
                    Connect wallet
                </button>
            </div>
        </header>
    );
}
