"use client";

import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

// /register と同じ理由でローカルに持つ client ラッパー。
// NextIntlClientProvider を Server Component から直接描画すると next-intl が
// plugin 構成（i18n/request.ts）を探しに行って throw するため、client component
// で包んで props（locale / messages）だけで完結させる。register 側の実装を
// import するとモジュール境界を跨ぐので、mypage 用に複製して独立を保つ。
export function MypageIntlProvider({
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
