import {
    RegisterHero,
    RegisterProgress,
    RegisterSidePanel,
    RegisterTopbar,
} from "../register-shared";

const identityOptions = [
    {
        id: "kyc",
        label: "KYC",
        description:
            "Use a provider-verified duplicate key. Raw KYC data and document images are not published by Sonari.",
    },
    {
        id: "world_id",
        label: "World ID",
        description:
            "Use a World ID nullifier for the Sonari claim action. You can set this up now or from the member area later.",
        defaultChecked: true,
    },
];

const identityStatements = [
    "I do not hold another active Sonari Membership SBT.",
    "I will not claim the same disaster from multiple Membership SBTs.",
    "I understand I can skip identity setup now and return before receiving Relief Cash.",
];

export default function RegisterIdentityPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar />

                <main className="page register-page">
                    <RegisterHero />

                    <section className="register-layout" aria-labelledby="identity-step-title">
                        <div className="register-flow">
                            <RegisterProgress current="identity" />

                            <form className="register-form register-step-page">
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">Optional anytime</div>
                                        <h2 id="identity-step-title">
                                            Add KYC or World ID now, later, or before claim.
                                        </h2>
                                    </div>
                                    <span className="tag tag-neutral">Skippable</span>
                                </div>

                                <div className="step-page-copy">
                                    <p>
                                        Initial registration only needs the wallet-bound Membership
                                        SBT and residence cell. Identity verification is an account
                                        setting you can complete anytime, and it becomes required
                                        only before payout.
                                    </p>
                                </div>

                                <fieldset className="control-group">
                                    <legend>Verification route</legend>
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
                                    <legend>Duplicate-account statement</legend>
                                    <div className="terms-list">
                                        {identityStatements.map((statement) => (
                                            <label className="terms-row" key={statement}>
                                                <input name="identityTerms" type="checkbox" />
                                                <span>{statement}</span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

                                <div className="claim-requirement-band">
                                    <div>
                                        <span>Initial registration</span>
                                        <strong>SBT + H3 cell</strong>
                                    </div>
                                    <div>
                                        <span>Anytime setting</span>
                                        <strong>KYC or World ID</strong>
                                    </div>
                                    <div>
                                        <span>Published data</span>
                                        <strong>Verified status only</strong>
                                    </div>
                                </div>

                                <div className="form-actions">
                                    <a
                                        className="btn btn-secondary btn-lg"
                                        href="/register/residence"
                                    >
                                        Back
                                    </a>
                                    <button className="btn btn-primary btn-lg" type="button">
                                        Start identity check
                                    </button>
                                    <button className="btn btn-secondary btn-lg" type="button">
                                        Skip and finish signup
                                    </button>
                                </div>
                            </form>
                        </div>

                        <RegisterSidePanel />
                    </section>
                </main>
            </div>
        </>
    );
}
