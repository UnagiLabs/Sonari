"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { SonariLocale } from "./register/wizard/locale";
import { LocaleSwitcher } from "./register/wizard/locale-switcher";

export function NotFoundView({ locale }: { readonly locale: SonariLocale }) {
    const t = useTranslations("notFound");

    return (
        <>
            <div className="watercolor-bg" />
            <div className="app not-found-app">
                <header className="not-found-header">
                    <a aria-label={t("brandHomeAria")} className="brand" href="/">
                        <span className="brand-mark">
                            <Image
                                alt="Sonari"
                                height={36}
                                priority
                                src="/assets/sonari_logo.png"
                                width={36}
                            />
                        </span>
                        <span className="brand-name">Sonari</span>
                    </a>
                    <LocaleSwitcher current={locale} />
                </header>

                <main className="not-found-main" aria-labelledby="not-found-title">
                    <div className="not-found-copy">
                        <p className="hero-eyebrow">{t("eyebrow")}</p>
                        <h1 id="not-found-title">{t("title")}</h1>
                        <p className="hero-sub">{t("body")}</p>
                        <a className="btn btn-primary btn-lg" href="/">
                            {t("homeCta")}
                        </a>
                    </div>
                    <div className="not-found-mark" aria-hidden="true">
                        <Image
                            alt=""
                            height={420}
                            priority
                            src="/assets/sonari_logo.png"
                            width={420}
                        />
                        <span>404</span>
                    </div>
                </main>
            </div>
        </>
    );
}
