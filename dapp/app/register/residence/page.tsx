import {
    RegisterHero,
    RegisterProgress,
    RegisterSidePanel,
    RegisterTopbar,
    ResidenceMapPreview,
} from "../register-shared";

const residenceStatements = [
    "This cell is my active residence area for Sonari eligibility checks.",
    "I understand changes after a disaster cutoff do not apply to that disaster.",
    "Sonari stores the selected H3 cell, not my raw address or GPS history.",
];

export default function RegisterResidencePage() {
    return (
        <>
            <div className="watercolor-bg" />
            <div className="app">
                <RegisterTopbar />

                <main className="page register-page">
                    <RegisterHero />

                    <section className="register-layout" aria-labelledby="residence-step-title">
                        <div className="register-flow">
                            <RegisterProgress current="residence" />

                            <form className="register-form register-step-page">
                                <div className="form-heading">
                                    <div>
                                        <div className="eyebrow">Step 2</div>
                                        <h2 id="residence-step-title">
                                            Choose your residence H3 cell from a map.
                                        </h2>
                                    </div>
                                    <span className="tag tag-neutral">Required</span>
                                </div>

                                <div className="step-page-copy">
                                    <p>
                                        Users should not need to type an H3 cell. Let them search an
                                        address or place, use current location, then confirm the map
                                        cell Sonari will register.
                                    </p>
                                </div>

                                <fieldset className="control-group">
                                    <legend>Find area</legend>
                                    <div className="residence-selector">
                                        <div className="residence-search-row">
                                            <label
                                                className="text-field"
                                                htmlFor="residence-search"
                                            >
                                                <span>Search city, station, or address</span>
                                                <input
                                                    id="residence-search"
                                                    name="residenceSearch"
                                                    placeholder="Shibuya, Tokyo"
                                                    type="text"
                                                />
                                                <small>
                                                    Search text may be sent to a map provider.
                                                    Sonari stores the selected H3 cell only.
                                                </small>
                                            </label>
                                            <button className="btn btn-secondary" type="button">
                                                Use current location
                                            </button>
                                        </div>

                                        <ResidenceMapPreview />

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
                                    <legend>Residence signature</legend>
                                    <div className="terms-list">
                                        {residenceStatements.map((statement) => (
                                            <label className="terms-row" key={statement}>
                                                <input name="residenceTerms" type="checkbox" />
                                                <span>{statement}</span>
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>

                                <div className="form-actions">
                                    <a className="btn btn-secondary btn-lg" href="/register">
                                        Back
                                    </a>
                                    <button className="btn btn-primary btn-lg" type="button">
                                        Save residence cell
                                    </button>
                                    <a
                                        className="btn btn-secondary btn-lg"
                                        href="/register/identity"
                                    >
                                        Add identity now
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
