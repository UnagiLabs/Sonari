"use client";

import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

// NextIntlClientProvider を Server Component から直接描画すると、next-intl が
// plugin 構成の config ファイル（i18n/request.ts）を探しに行って throw する。
// client component で包めば props（locale / messages）だけで完結するため、
// plugin なし・cookie ベースの構成を保てる。
export function RegisterIntlProvider({
    locale,
    messages,
    children,
}: {
    readonly locale: string;
    readonly messages: AbstractIntlMessages;
    readonly children: ReactNode;
}) {
    return (
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Tokyo">
            {children}
        </NextIntlClientProvider>
    );
}
