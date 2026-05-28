import {
    RegisterHero,
    RegisterProgress,
    RegisterSidePanel,
    RegisterTopbar,
} from "./register-shared";

const passTerms = [
    "This wallet will own one active Sonari Membership SBT.",
    "The Membership SBT is soulbound and cannot be transferred.",
    "Holding a Membership SBT does not guarantee aid or create payout priority.",
];

export default function RegisterPage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar />

                <main className="page register-page">
                    <RegisterHero />

                    <section className="register-layout" aria-labelledby="register-step-title">
                        <div className="register-flow">
                            <RegisterProgress current="pass" />

                            <form className="register-form register-step-page">
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">Step 1</div>
                                        <h2 id="register-step-title">
                                            Issue one soulbound Membership SBT.
                                        </h2>
                                    </div>
                                    <span className="tag tag-neutral">Required</span>
                                </div>

                                <div className="step-page-copy">
                                    <p>
                                        The first registration action creates the member account for
                                        the connected Sui address. Backend integration should reject
                                        duplicate active Membership SBTs for the same wallet.
                                    </p>
                                </div>

                                <section
                                    className="sbt-preview-band"
                                    aria-label="Membership SBT preview"
                                >
                                    <div>
                                        <span>Object type</span>
                                        <strong>Membership SBT</strong>
                                    </div>
                                    <div>
                                        <span>Owner</span>
                                        <strong className="mono-value">0x7a9...21c</strong>
                                    </div>
                                    <div>
                                        <span>Transfer</span>
                                        <strong>Disabled</strong>
                                    </div>
                                    <div>
                                        <span>Status</span>
                                        <strong>Not issued yet</strong>
                                    </div>
                                </section>

                                <fieldset className="control-group">
                                    <legend>Wallet check</legend>
                                    <div className="single-step-fields">
                                        <div className="field-note">
                                            <strong>Connected address</strong>
                                            <span>Loaded from wallet later</span>
                                            <small>
                                                If this address already has an active Membership
                                                SBT, redirect to /member instead of showing
                                                registration.
                                            </small>
                                        </div>
                                        <button className="btn btn-secondary" type="button">
                                            Check existing SBT
                                        </button>
                                    </div>
                                </fieldset>

                                <fieldset className="control-group">
                                    <legend>Before issuing</legend>
                                    <div className="terms-list">
                                        {passTerms.map((statement) => (
                                            <label className="terms-row" key={statement}>
                                                <input name="passTerms" type="checkbox" />
                                                <span>{statement}</span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

                                <div className="form-actions">
                                    <button className="btn btn-primary btn-lg" type="button">
                                        Issue Membership SBT
                                    </button>
                                    <a
                                        className="btn btn-secondary btn-lg"
                                        href="/register/residence"
                                    >
                                        Next: choose residence cell
                                    </a>
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
