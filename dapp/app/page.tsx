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
                            Choose a cause you believe in. Sonari helps your support reach the right
                            person it was meant for — and lets you see the story after you give.
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
                            No black boxes, no vague handoffs. Your donation moves through clear
                            rules toward a real person.
                        </p>
                    </div>

                    <div className="hero-figure reveal">
                        <figure className="hero-slide active">
                            <Image
                                src="/assets/donation_flood.webp"
                                alt="Community recovery pool"
                                fill
                                priority
                                sizes="(min-width: 900px) 45vw, 100vw"
                            />
                            <figcaption className="hero-caption">
                                <div className="label">Designated support pool</div>
                                <div className="name">Community recovery fund</div>
                                <div className="pool-status">
                                    <span className="dot" aria-hidden="true"></span>
                                    Active — support goes to people who qualify
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
                                alt="Regional aid pool"
                                fill
                                sizes="(min-width: 900px) 45vw, 100vw"
                            />
                            <figcaption className="hero-caption">
                                <div className="label">General support pool</div>
                                <div className="name">Regional aid fund</div>
                                <div className="pool-status">
                                    <span className="dot" aria-hidden="true"></span>
                                    Flexible — ready for the next place that needs help
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
                                <div className="label">Program pool</div>
                                <div className="name">Student support fund</div>
                                <div className="pool-status soon">
                                    <span className="dot" aria-hidden="true"></span>
                                    In design — helping students stay on track
                                </div>
                                <div className="figures">
                                    <span>Launching 2026</span>
                                    <span>Early contributors welcome</span>
                                </div>
                            </figcaption>
                        </figure>
                        <fieldset className="hero-dots" aria-label="Support pools">
                            <button
                                type="button"
                                className="active"
                                aria-label="Show community recovery fund"
                            ></button>
                            <button type="button" aria-label="Show regional aid fund"></button>
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
                        <p>You choose the pool your heart wants to back.</p>
                    </div>
                    <div className="principle reveal">
                        <div className="word">Fair</div>
                        <p>
                            Support goes to people who match the program, not whoever shouts the
                            loudest.
                        </p>
                    </div>
                    <div className="principle reveal">
                        <div className="word">Visible</div>
                        <p>Follow your gift from a good intention to the person it reaches.</p>
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
                                <h3>You can't see who it reached</h3>
                                <p>
                                    Too many donations disappear behind reports, intermediaries, and
                                    delayed updates.
                                </p>
                            </article>
                            <article className="problem-item">
                                <h3>The path has too many handoffs</h3>
                                <p>
                                    When support passes through many organizations, it becomes hard
                                    to know when it arrived or what it was used for.
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
                                “I didn't just want to give. I wanted to know someone actually
                                received it.”
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
                        <h2>Give to a cause. Let Sonari help it reach the right hands.</h2>
                        <p>
                            A donation should feel less like sending money away and more like
                            standing beside someone directly. Sonari keeps the path simple, visible,
                            and fair.
                        </p>
                    </div>

                    <div className="flow">
                        <article className="flow-step reveal">
                            <div className="stage">Contribute</div>
                            <h3>Choose where your care goes</h3>
                            <p>
                                Give to a general pool, a local campaign, a student program, or an
                                emergency fund with a purpose you understand.
                            </p>
                        </article>
                        <article className="flow-step reveal">
                            <div className="stage">Register</div>
                            <h3>People prepare once</h3>
                            <p>
                                Recipients register the basics ahead of time, so support can be sent
                                without messy paperwork when it matters.
                            </p>
                        </article>
                        <article className="flow-step reveal">
                            <div className="stage">Distribute</div>
                            <h3>Support reaches the right people</h3>
                            <p>
                                Sonari checks who qualifies for each program, sends support to
                                individuals under clear rules, and leaves a trail donors can follow.
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
                        <h2>One platform for many kinds of care.</h2>
                        <p>
                            Whether it is a neighborhood, a student, a family, or a campaign, Sonari
                            gives every pool a clear purpose and every recipient a visible reason.
                        </p>
                    </div>

                    <div className="causes-grid">
                        <article className="cause reveal">
                            <figure>
                                <Image
                                    src="/assets/donation_earthquake.png"
                                    alt="General support pool"
                                    fill
                                    sizes="(min-width: 720px) 33vw, 100vw"
                                />
                            </figure>
                            <div className="cause-head">
                                <h3>General support pool</h3>
                                <span className="status">Open</span>
                            </div>
                            <p>
                                A shared pool for moments when help is needed most and one campaign
                                cannot carry it alone.
                            </p>
                        </article>
                        <article className="cause reveal">
                            <figure>
                                <Image
                                    src="/assets/donation_flood.webp"
                                    alt="Regional campaign pool"
                                    fill
                                    sizes="(min-width: 720px) 33vw, 100vw"
                                />
                            </figure>
                            <div className="cause-head">
                                <h3>Regional campaign pool</h3>
                                <span className="status">Designated</span>
                            </div>
                            <p>
                                Support for a place, community, or campaign that donors want to
                                stand behind.
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
                                A future pool for students facing hardship, built to keep learning
                                within reach.
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
                            Every part of Sonari is designed around one promise: people should feel
                            the trust behind every gift.
                        </p>
                    </div>

                    <div className="trust-grid">
                        <div className="trust-points reveal">
                            <article className="trust-point">
                                <h3>Verified, not assumed</h3>
                                <p>
                                    Recipients carry a Membership SBT verified by KYC or World ID.
                                    KYC and World ID follow the same full-support route.
                                </p>
                            </article>
                            <article className="trust-point">
                                <h3>Transparent by default</h3>
                                <p>
                                    Donors can see pool balances, program rules, and when support
                                    reaches recipients.
                                </p>
                            </article>
                            <article className="trust-point">
                                <h3>Privacy you can rely on</h3>
                                <p>
                                    Sensitive details stay private. Support goes to the Membership
                                    SBT owner under the program rules.
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
                                <span>Rules and receipts donors can follow</span>
                            </div>
                            <div className="trust-stat">
                                <strong>Real time</strong>
                                <span>Live fund-flow dashboard</span>
                            </div>
                            <div className="trust-stat">
                                <strong>Zero</strong>
                                <span>Raw identity details stored on-chain</span>
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
                        Join Sonari and help every act of generosity become something people can
                        trust, feel, and follow.
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
