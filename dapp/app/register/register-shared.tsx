import Image from "next/image";

type RegistrationStep = {
    href: string;
    label: string;
    detail: string;
    status: "current" | "done" | "optional" | "upcoming";
};

type ProgressProps = {
    current: "pass" | "residence" | "identity";
};

type SummaryRow = {
    label: string;
    value: string;
};

export const mapCells = [
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

export const privacyRows: SummaryRow[] = [
    { label: "Wallet address", value: "SBT owner only" },
    { label: "Nickname", value: "Can be added later" },
    { label: "Address search", value: "Not stored by Sonari" },
    { label: "Phone / email", value: "Not collected" },
    { label: "GPS history", value: "Not stored" },
    { label: "Device info", value: "Not published" },
    { label: "H3 cell", value: "Resolution 7 output" },
];

const progressByStep: Record<ProgressProps["current"], RegistrationStep[]> = {
    pass: [
        {
            href: "/register",
            label: "Step 1",
            detail: "Issue one wallet-bound Membership SBT",
            status: "current",
        },
        {
            href: "/register/residence",
            label: "Step 2",
            detail: "Choose an H3 residence cell",
            status: "upcoming",
        },
        {
            href: "/register/identity",
            label: "Anytime",
            detail: "Add KYC or World ID when ready",
            status: "optional",
        },
    ],
    residence: [
        {
            href: "/register",
            label: "Step 1",
            detail: "Membership SBT prepared",
            status: "done",
        },
        {
            href: "/register/residence",
            label: "Step 2",
            detail: "Choose an H3 residence cell",
            status: "current",
        },
        {
            href: "/register/identity",
            label: "Anytime",
            detail: "Add KYC or World ID when ready",
            status: "optional",
        },
    ],
    identity: [
        {
            href: "/register",
            label: "Step 1",
            detail: "Membership SBT prepared",
            status: "done",
        },
        {
            href: "/register/residence",
            label: "Step 2",
            detail: "Residence cell selected",
            status: "done",
        },
        {
            href: "/register/identity",
            label: "Anytime",
            detail: "Optional identity setup",
            status: "current",
        },
    ],
};

export function RegisterTopbar() {
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

export function RegisterHero() {
    return (
        <header className="register-hero">
            <div>
                <div className="eyebrow">Register</div>
                <h1>Create a member account in clear steps.</h1>
                <p className="muted register-sub">
                    First create one soulbound Membership SBT for the connected wallet, then choose
                    a residence H3 cell from a map. KYC or World ID is optional during signup and
                    can be added from the member area whenever you are ready.
                </p>
            </div>
            <div className="register-wallet-panel">
                <span className="tag tag-neutral">First-time wallet</span>
                <p>
                    Backend routing should show this flow only when the connected address has no
                    active Membership SBT. Registered wallets should land on /member.
                </p>
                <button className="btn btn-primary" type="button">
                    Connect wallet
                </button>
            </div>
        </header>
    );
}

export function RegisterProgress({ current }: ProgressProps) {
    return (
        <nav className="register-progress" aria-label="Registration progress">
            {progressByStep[current].map((step) => (
                <a className={`progress-item ${step.status}`} href={step.href} key={step.href}>
                    <span>{step.label}</span>
                    <strong>{step.detail}</strong>
                </a>
            ))}
        </nav>
    );
}

export function RegisterSidePanel() {
    return (
        <aside className="register-side" aria-labelledby="register-side-title">
            <section className="register-summary-panel">
                <div className="panel-header compact">
                    <div>
                        <div className="eyebrow">Initial registration</div>
                        <h2 id="register-side-title">Required now</h2>
                    </div>
                </div>
                <div className="register-summary-list">
                    <div className="register-summary-row">
                        <span>Step 1</span>
                        <strong>One Membership SBT per wallet</strong>
                    </div>
                    <div className="register-summary-row">
                        <span>Step 2</span>
                        <strong>One active H3 resolution 7 residence cell</strong>
                    </div>
                    <div className="register-summary-row">
                        <span>Optional anytime</span>
                        <strong>KYC or World ID can be added later</strong>
                    </div>
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
        </aside>
    );
}

export function ResidenceMapPreview() {
    return (
        <div className="residence-map-picker" aria-hidden="true">
            <div className="map-grid" aria-hidden="true">
                {mapCells.map((cell) => (
                    <span className={cell === "selected" ? "selected" : undefined} key={cell} />
                ))}
            </div>
            <div className="map-pin" aria-hidden="true" />
        </div>
    );
}
