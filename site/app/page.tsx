"use client";

import Image from "next/image";
import { useEffect } from "react";

export default function LandingPage() {
    useEffect(() => {
        const header = document.getElementById("header");
        if (!header) {
            return undefined;
        }

        const onScroll = () => {
            header.classList.toggle("scrolled", window.scrollY > 8);
        };

        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const revealEls = document.querySelectorAll<HTMLElement>(".reveal");
        let observer: IntersectionObserver | undefined;

        if (!reduce && "IntersectionObserver" in window) {
            observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            entry.target.classList.add("in");
                            observer?.unobserve(entry.target);
                        }
                    });
                },
                { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
            );

            revealEls.forEach((element, index) => {
                element.style.transitionDelay = `${Math.min(index % 3, 2) * 90}ms`;
                observer?.observe(element);
            });
        } else {
            revealEls.forEach((element) => {
                element.classList.add("in");
            });
        }

        const slides = document.querySelectorAll<HTMLElement>(".hero-slide");
        const dots = document.querySelectorAll<HTMLButtonElement>(".hero-dots button");
        const cleanupDotHandlers: Array<() => void> = [];
        let currentSlide = 0;
        let timer: number | undefined;

        const showSlide = (nextSlide: number) => {
            slides.item(currentSlide)?.classList.remove("active");
            dots.item(currentSlide)?.classList.remove("active");
            currentSlide = nextSlide;
            slides.item(currentSlide)?.classList.add("active");
            dots.item(currentSlide)?.classList.add("active");
        };

        const play = () => {
            if (!reduce && slides.length > 1) {
                timer = window.setInterval(() => {
                    showSlide((currentSlide + 1) % slides.length);
                }, 4800);
            }
        };

        if (slides.length > 1 && dots.length === slides.length) {
            dots.forEach((dot, index) => {
                const onClick = () => {
                    showSlide(index);
                    if (timer) {
                        window.clearInterval(timer);
                    }
                    play();
                };
                dot.addEventListener("click", onClick);
                cleanupDotHandlers.push(() => dot.removeEventListener("click", onClick));
            });
            play();
        }

        return () => {
            window.removeEventListener("scroll", onScroll);
            observer?.disconnect();
            if (timer) {
                window.clearInterval(timer);
            }
            cleanupDotHandlers.forEach((cleanup) => {
                cleanup();
            });
        };
    }, []);

    return (
        <>
            {/* ===== Header ===== */}
            <header className="site-header" id="header">
                <div className="wrap nav">
                    <a className="brand" href="#top" aria-label="Sonari home">
                        <Image
                            src="/assets/sonari_logo.png"
                            alt="Sonari"
                            width={64}
                            height={64}
                            loading="eager"
                            priority
                        />
                    </a>
                    <nav className="nav-links" aria-label="Primary">
                        <a href="#problem">Why it matters</a>
                        <a href="#how">How it works</a>
                        <a href="#causes">Causes</a>
                        <a href="#trust">Trust</a>
                    </nav>
                    <div className="nav-cta">
                        <a className="nav-ghost" href="/sonari_overview.html">
                            Read the spec
                        </a>
                        <a className="btn btn-primary btn-sm" href="/sonari_overview.html">
                            Start donating
                        </a>
                    </div>
                </div>
            </header>

            {/* ===== Hero ===== */}
            <section className="hero">
                <div className="wrap hero-grid">
                    <div className="hero-copy reveal">
                        <span className="hero-eyebrow">Transparent donation infrastructure</span>
                        <h1>
                            Donations you can <em>actually follow.</em>
                        </h1>
                        <p className="hero-lead">
                            Sonari keeps disaster-relief pools funded before crisis strikes.
                            Contribute to a flood or earthquake pool, and your support is ready to
                            deploy the moment it's needed.
                        </p>
                        <div className="hero-actions">
                            <a className="btn btn-primary" href="/sonari_overview.html">
                                Start donating
                                <span className="arrow" aria-hidden="true">
                                    &rarr;
                                </span>
                            </a>
                            <a className="btn btn-ghost" href="#how">
                                See how it works
                            </a>
                        </div>
                        <p className="hero-note">
                            Every contribution is verified on-chain — no black boxes, no guesswork
                            about where your money went.
                        </p>
                    </div>

                    <div className="hero-figure reveal">
                        <figure className="hero-slide active">
                            <Image
                                src="/assets/donation_flood.webp"
                                alt="Flood relief pool"
                                fill
                                priority
                                sizes="(min-width: 900px) 45vw, 100vw"
                            />
                            <figcaption className="hero-caption">
                                <div className="label">Standing relief pool</div>
                                <div className="name">Flood relief fund</div>
                                <div className="pool-status">
                                    <span className="dot" aria-hidden="true"></span>
                                    Funded &amp; ready — deploys when a flood is verified
                                </div>
                                <div className="figures">
                                    <span>¥3,640,000 in the pool</span>
                                    <span>1,284 contributors</span>
                                </div>
                            </figcaption>
                        </figure>
                        <figure className="hero-slide">
                            <Image
                                src="/assets/donation_earthquake.png"
                                alt="Earthquake relief pool"
                                fill
                                sizes="(min-width: 900px) 45vw, 100vw"
                            />
                            <figcaption className="hero-caption">
                                <div className="label">Standing relief pool</div>
                                <div className="name">Earthquake relief fund</div>
                                <div className="pool-status">
                                    <span className="dot" aria-hidden="true"></span>
                                    Funded &amp; ready — deploys when an earthquake is verified
                                </div>
                                <div className="figures">
                                    <span>¥5,210,000 in the pool</span>
                                    <span>1,902 contributors</span>
                                </div>
                            </figcaption>
                        </figure>
                        <figure className="hero-slide">
                            <Image
                                src="/assets/donation_student.png"
                                alt="Student support pool"
                                fill
                                sizes="(min-width: 900px) 45vw, 100vw"
                            />
                            <figcaption className="hero-caption">
                                <div className="label">Upcoming relief pool</div>
                                <div className="name">Student support fund</div>
                                <div className="pool-status soon">
                                    <span className="dot" aria-hidden="true"></span>
                                    Opening soon — pool now in design
                                </div>
                                <div className="figures">
                                    <span>Launching 2026</span>
                                    <span>Early contributors welcome</span>
                                </div>
                            </figcaption>
                        </figure>
                        <fieldset className="hero-dots" aria-label="Relief pools">
                            <button
                                type="button"
                                className="active"
                                aria-label="Show flood relief fund"
                            ></button>
                            <button type="button" aria-label="Show earthquake relief fund"></button>
                            <button type="button" aria-label="Show student support fund"></button>
                        </fieldset>
                    </div>
                </div>
            </section>

            {/* ===== Principles ===== */}
            <section className="principles">
                <div className="wrap principles-grid">
                    <div className="principle reveal">
                        <div className="word">Clear</div>
                        <p>You always know which relief pool your contribution backs.</p>
                    </div>
                    <div className="principle reveal">
                        <div className="word">Fast</div>
                        <p>
                            Pools are funded in advance, so support deploys the instant disaster
                            strikes.
                        </p>
                    </div>
                    <div className="principle reveal">
                        <div className="word">Visible</div>
                        <p>Follow the outcome — from your contribution to a real result.</p>
                    </div>
                </div>
            </section>

            {/* ===== Problem ===== */}
            <section id="problem" className="block">
                <div className="wrap">
                    <div className="head reveal">
                        <span className="kicker">Why it matters</span>
                        <h2>Giving shouldn't feel like sending money into the dark.</h2>
                        <p>
                            People want to help. But when the path from donation to impact is
                            unclear, trust becomes the hardest part of giving.
                        </p>
                    </div>

                    <div className="problem-grid">
                        <div className="problem-list reveal">
                            <article className="problem-item">
                                <h3>You can't see where it goes</h3>
                                <p>
                                    Vague reporting leaves donors unsure whether their support ever
                                    reached a real person.
                                </p>
                            </article>
                            <article className="problem-item">
                                <h3>Aid arrives too slowly</h3>
                                <p>
                                    In disasters and emergencies every hour counts — yet funds often
                                    crawl through slow, opaque processes.
                                </p>
                            </article>
                            <article className="problem-item">
                                <h3>The reason stays unclear</h3>
                                <p>
                                    Trust grows when communities can show why support was sent and
                                    what changed afterward.
                                </p>
                            </article>
                        </div>

                        <aside className="problem-aside reveal">
                            <p className="quote">
                                “I gave because I wanted to help. I just never found out if I
                                actually did.”
                            </p>
                            <p className="by">— The gap Sonari was built to close</p>
                        </aside>
                    </div>
                </div>
            </section>

            {/* ===== How it works ===== */}
            <section id="how" className="block block-soft">
                <div className="wrap">
                    <div className="head reveal">
                        <span className="kicker">How it works</span>
                        <h2>Support that's ready before disaster strikes.</h2>
                        <p>
                            Instead of scrambling to raise money after a crisis, Sonari keeps relief
                            pools funded in advance — so help can move the moment it's needed.
                        </p>
                    </div>

                    <div className="flow">
                        <article className="flow-step reveal">
                            <div className="stage">Contribute</div>
                            <h3>Fund a relief pool</h3>
                            <p>
                                Choose a disaster pool — flood, earthquake, and more — and add your
                                contribution. It waits there, ready.
                            </p>
                        </article>
                        <article className="flow-step reveal">
                            <div className="stage">Verify</div>
                            <h3>A disaster triggers it</h3>
                            <p>
                                When a flood or earthquake hits and is confirmed on-chain, the
                                matching pool activates — no slow approvals.
                            </p>
                        </article>
                        <article className="flow-step reveal">
                            <div className="stage">Deliver</div>
                            <h3>Support reaches people</h3>
                            <p>
                                The pool releases aid to verified recipients in the affected area —
                                and you can follow exactly where it went.
                            </p>
                        </article>
                    </div>
                </div>
            </section>

            {/* ===== Causes ===== */}
            <section id="causes" className="block">
                <div className="wrap">
                    <div className="head reveal">
                        <span className="kicker">Where you can help</span>
                        <h2>Relief pools, ready before disaster strikes.</h2>
                        <p>
                            Contribute to a standing pool today — Sonari is built to grow into more
                            disaster types and community programs.
                        </p>
                    </div>

                    <div className="causes-grid">
                        <article className="cause reveal">
                            <figure>
                                <Image
                                    src="/assets/donation_earthquake.png"
                                    alt="Earthquake relief pool"
                                    fill
                                    sizes="(min-width: 720px) 33vw, 100vw"
                                />
                            </figure>
                            <div className="cause-head">
                                <h3>Earthquake pool</h3>
                                <span className="status">Funded &amp; ready</span>
                            </div>
                            <p>
                                Standing support that deploys to displaced families the moment an
                                earthquake is verified.
                            </p>
                        </article>
                        <article className="cause reveal">
                            <figure>
                                <Image
                                    src="/assets/donation_flood.webp"
                                    alt="Flood relief pool"
                                    fill
                                    sizes="(min-width: 720px) 33vw, 100vw"
                                />
                            </figure>
                            <div className="cause-head">
                                <h3>Flood pool</h3>
                                <span className="status">Funded &amp; ready</span>
                            </div>
                            <p>
                                Shelter, clean water, and rebuilding — released the moment a flood
                                is verified.
                            </p>
                        </article>
                        <article className="cause reveal">
                            <figure>
                                <Image
                                    src="/assets/donation_student.png"
                                    alt="Student support pool"
                                    fill
                                    sizes="(min-width: 720px) 33vw, 100vw"
                                />
                            </figure>
                            <div className="cause-head">
                                <h3>Student support</h3>
                                <span className="status soon">Coming soon</span>
                            </div>
                            <p>
                                A future pool to help students keep learning through hardship and
                                disruption.
                            </p>
                        </article>
                    </div>
                </div>
            </section>

            {/* ===== Trust ===== */}
            <section id="trust" className="block trust">
                <div className="wrap">
                    <div className="head reveal">
                        <span className="kicker">Why Sonari</span>
                        <h2>Built to earn trust — not just ask for it.</h2>
                        <p>
                            Every part of Sonari is designed around one promise: you always know
                            what your money did.
                        </p>
                    </div>

                    <div className="trust-grid">
                        <div className="trust-points reveal">
                            <article className="trust-point">
                                <h3>Verified, not assumed</h3>
                                <p>
                                    Eligibility and delivery are confirmed on-chain, so support
                                    reaches the right people.
                                </p>
                            </article>
                            <article className="trust-point">
                                <h3>Transparent by default</h3>
                                <p>
                                    Fund flows and operating ratios are open on a live dashboard —
                                    anyone can check.
                                </p>
                            </article>
                            <article className="trust-point">
                                <h3>Privacy you can rely on</h3>
                                <p>
                                    Personal data stays off-chain. Only what's needed to verify
                                    support is ever used.
                                </p>
                            </article>
                        </div>

                        <div className="trust-stats reveal">
                            <div className="trust-stat">
                                <strong>100%</strong>
                                <span>Of donations tied to a defined purpose</span>
                            </div>
                            <div className="trust-stat">
                                <strong>On-chain</strong>
                                <span>Verified eligibility and delivery</span>
                            </div>
                            <div className="trust-stat">
                                <strong>Real time</strong>
                                <span>Live fund-flow dashboard</span>
                            </div>
                            <div className="trust-stat">
                                <strong>Zero</strong>
                                <span>Personal data stored on-chain</span>
                            </div>
                            <p className="trust-disclaimer">
                                Sonari is donation infrastructure — it does not promise payouts.
                                Support runs on transparent program conditions.
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            {/* ===== Final CTA ===== */}
            <section className="block cta">
                <div className="wrap reveal">
                    <span className="kicker">Start today</span>
                    <h2>Make giving feel clear, human, and worth trusting.</h2>
                    <p>
                        Join Sonari and help support move from good intentions to visible outcomes.
                    </p>
                    <div className="hero-actions">
                        <a className="btn btn-primary" href="/sonari_overview.html">
                            Start donating
                            <span className="arrow" aria-hidden="true">
                                &rarr;
                            </span>
                        </a>
                        <a className="btn btn-ghost" href="/sonari_overview.html">
                            Read the full spec
                        </a>
                    </div>
                </div>
            </section>

            {/* ===== Footer ===== */}
            <footer>
                <div className="wrap">
                    <div className="foot-top">
                        <div className="foot-brand">
                            <Image
                                src="/assets/sonari_logo.png"
                                alt="Sonari"
                                width={70}
                                height={70}
                            />
                            <p>Transparent donation infrastructure for verified aid.</p>
                        </div>
                        <nav className="foot-links" aria-label="Footer">
                            <a href="#problem">Why it matters</a>
                            <a href="#how">How it works</a>
                            <a href="#causes">Causes</a>
                            <a href="#trust">Trust</a>
                            <a href="/sonari_overview.html">Spec</a>
                        </nav>
                    </div>
                    <div className="foot-bottom">
                        <span>© 2026 Sonari</span>
                        <span>Make every donation visible.</span>
                    </div>
                </div>
            </footer>
        </>
    );
}
