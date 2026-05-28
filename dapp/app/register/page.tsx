import Image from "next/image";

type IdentityOption = {
    id: "kyc" | "world_id";
    label: string;
    description: string;
    defaultChecked?: boolean;
};

type RegistrationStep = {
    label: string;
    detail: string;
    status: "ready" | "current" | "pending";
};

type SummaryRow = {
    label: string;
    value: string;
};

const registrationSteps: RegistrationStep[] = [
    { label: "Wallet", detail: "Connect Sui address", status: "ready" },
    { label: "Profile", detail: "Choose display nickname", status: "current" },
    { label: "MembershipPass", detail: "Create recipient pass", status: "pending" },
    { label: "Identity", detail: "KYC or World ID", status: "pending" },
    { label: "Residence", detail: "Register H3 res 7 cell", status: "pending" },
    { label: "Signature", detail: "Accept account terms", status: "pending" },
];

const identityOptions: IdentityOption[] = [
    {
        id: "kyc",
        label: "KYC",
        description: "Provider response is verified by Nautilus. Raw KYC data is not published.",
    },
    {
        id: "world_id",
        label: "World ID",
        description: "Uses the Sonari action sonari_membership_register_v1.",
        defaultChecked: true,
    },
];

const privacyRows = [
    { label: "Nickname", value: "Display only" },
    { label: "Wallet address", value: "Owner account" },
    { label: "Address search", value: "Not stored by Sonari" },
    { label: "Phone / email", value: "Not collected" },
    { label: "GPS history", value: "Not stored" },
    { label: "Device info", value: "Not published" },
    { label: "H3 cell", value: "Read-only output" },
];

const registrationSummary: SummaryRow[] = [
    { label: "MembershipPass status", value: "Not created yet" },
    { label: "Identity status", value: "Waiting for provider" },
    { label: "Residence status", value: "H3 cell not verified" },
    { label: "Terms version", value: "v1" },
];

const termsStatements = [
    "I do not hold another active Sonari Membership SBT.",
    "I will not claim the same disaster from multiple Membership SBTs.",
    "I understand false claims can lead to suspension or recovery requests.",
];

const mapCells = [
    "north-west",
    "north",
    "north-east",
    "west-ridge",
    "center-west",
    "center-north",
    "center-east",
    "east-ridge",
    "selected",
    "south-west",
    "south",
    "south-east",
    "river-west",
    "river",
    "river-east",
    "outer-west",
    "outer-south",
    "outer-east",
];

export default function RegisterPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar />

                <main className="page register-page">
                    <header className="register-hero">
                        <div>
                            <div className="eyebrow">Register</div>
                            <h1>Create your MembershipPass.</h1>
                            <p className="muted register-sub">
                                Register a wallet-owned recipient account with a display nickname,
                                verified identity route, residence H3 cell, and signed account
                                terms.
                            </p>
                        </div>
                        <div className="register-wallet-panel">
                            <span className="tag tag-neutral">First-time wallet</span>
                            <p>
                                If this address has no MembershipPass, continue here. Registered
                                users should land on the member home page.
                            </p>
                            <button className="btn btn-primary" type="button">
                                Connect wallet
                            </button>
                        </div>
                    </header>

                    <section className="register-layout" aria-labelledby="register-form-title">
                        <form className="register-form">
                            <div className="form-heading">
                                <div>
                                    <div className="eyebrow">Account setup</div>
                                    <h2 id="register-form-title">Recipient registration</h2>
                                </div>
                                <span className="tag tag-neutral">Preview</span>
                            </div>

                            <section className="register-stepper" aria-labelledby="steps-title">
                                <h3 id="steps-title">Registration flow</h3>
                                <ol>
                                    {registrationSteps.map((step, index) => (
                                        <li className={`step-pill ${step.status}`} key={step.label}>
                                            <span>{index + 1}</span>
                                            <div>
                                                <strong>{step.label}</strong>
                                                <small>{step.detail}</small>
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            </section>

                            <fieldset className="control-group">
                                <legend>Profile</legend>
                                <div className="profile-fields">
                                    <label className="text-field" htmlFor="nickname">
                                        <span>Nickname</span>
                                        <input
                                            id="nickname"
                                            maxLength={32}
                                            name="nickname"
                                            placeholder="haru.sui"
                                            type="text"
                                        />
                                        <small>
                                            Used for member display only. It does not affect
                                            eligibility.
                                        </small>
                                    </label>
                                    <div className="field-note">
                                        <strong>Account owner</strong>
                                        <span>0x7a9...21c</span>
                                        <small>Loaded from connected wallet later.</small>
                                    </div>
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>MembershipPass</legend>
                                <div className="pass-preview-panel">
                                    <div>
                                        <div className="eyebrow">Pass preview</div>
                                        <h3>MembershipPass</h3>
                                        <p>
                                            A wallet-owned SBT used for Claim eligibility checks. It
                                            is not transferable.
                                        </p>
                                    </div>
                                    <button className="btn btn-secondary" type="button">
                                        Create pass preview
                                    </button>
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>Identity verification</legend>
                                <div className="identity-choice-list">
                                    {identityOptions.map((option) => (
                                        <label className="identity-choice" key={option.id}>
                                            <input
                                                defaultChecked={option.defaultChecked}
                                                name="identityProvider"
                                                type="radio"
                                                value={option.id}
                                            />
                                            <span>
                                                <strong>{option.label}</strong>
                                                <small>{option.description}</small>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>Residence area</legend>
                                <div className="residence-selector">
                                    <div className="residence-search-row">
                                        <label className="text-field" htmlFor="residence-search">
                                            <span>Search city, station, or address</span>
                                            <input
                                                id="residence-search"
                                                name="residenceSearch"
                                                placeholder="Shibuya, Tokyo"
                                                type="text"
                                            />
                                            <small>
                                                Search text may be sent to a map provider. Sonari
                                                stores the selected H3 cell only.
                                            </small>
                                        </label>
                                        <button className="btn btn-secondary" type="button">
                                            Use current location
                                        </button>
                                    </div>

                                    <div className="residence-map-picker" aria-hidden="true">
                                        <div className="map-grid" aria-hidden="true">
                                            {mapCells.map((cell) => (
                                                <span
                                                    className={
                                                        cell === "selected" ? "selected" : undefined
                                                    }
                                                    key={cell}
                                                />
                                            ))}
                                        </div>
                                        <div className="map-pin" aria-hidden="true" />
                                    </div>

                                    <div className="selected-area-summary">
                                        <div>
                                            <span>Selected residence area</span>
                                            <strong>Shibuya, Tokyo · approx. 0.74 km2</strong>
                                        </div>
                                        <div>
                                            <span>H3 resolution</span>
                                            <strong>7</strong>
                                        </div>
                                        <div>
                                            <span>Cell ID</span>
                                            <strong className="mono-value">
                                                h3-8a30a10cfffffff
                                            </strong>
                                        </div>
                                        <div>
                                            <span>Allowlist</span>
                                            <strong>land_allowlist_res7 pending</strong>
                                        </div>
                                    </div>

                                    <details className="advanced-cell-input">
                                        <summary>Advanced cell input</summary>
                                        <label className="text-field" htmlFor="home-cell">
                                            <span>H3 resolution 7 cell</span>
                                            <input
                                                defaultValue="h3-8a30a10cfffffff"
                                                id="home-cell"
                                                name="homeCell"
                                                type="text"
                                            />
                                        </label>
                                    </details>
                                </div>
                            </fieldset>

                            <fieldset className="control-group">
                                <legend>Terms signature</legend>
                                <div className="terms-list">
                                    {termsStatements.map((statement) => (
                                        <label className="terms-row" key={statement}>
                                            <input name="terms" type="checkbox" />
                                            <span>{statement}</span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>

                            <div className="form-actions">
                                <button className="btn btn-primary btn-lg" type="button">
                                    Sign & register preview
                                </button>
                                <a className="btn btn-secondary btn-lg" href="/claim">
                                    Go to claim
                                </a>
                            </div>
                        </form>

                        <aside className="register-side" aria-labelledby="register-summary-title">
                            <section className="register-summary-panel">
                                <div className="panel-header compact">
                                    <div>
                                        <div className="eyebrow">Registration state</div>
                                        <h2 id="register-summary-title">Account preview</h2>
                                    </div>
                                </div>
                                <div className="register-summary-list">
                                    {registrationSummary.map((row) => (
                                        <div className="register-summary-row" key={row.label}>
                                            <span>{row.label}</span>
                                            <strong>{row.value}</strong>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="privacy-panel">
                                <h3>Privacy boundary</h3>
                                <div className="privacy-list">
                                    {privacyRows.map((row) => (
                                        <div className="privacy-row" key={row.label}>
                                            <span>{row.label}</span>
                                            <strong>{row.value}</strong>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="member-route-panel">
                                <div className="eyebrow">After registration</div>
                                <h3>Send registered wallets to /member.</h3>
                                <p>
                                    The member home page should show pass status, identity status,
                                    residence status, claimable events, and profile settings.
                                </p>
                            </section>
                        </aside>
                    </section>
                </main>
            </div>
        </>
    );
}

function RegisterTopbar() {
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
                    <a className="nav-item active" href="/register">
                        Register
                    </a>
                    <a className="nav-item" href="/claim">
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
