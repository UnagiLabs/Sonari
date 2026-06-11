"use client";

import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

// 全ページ共通の client ラッパー。
// NextIntlClientProvider を Server Component から直接描画すると next-intl が
// plugin 構成（i18n/request.ts）を探しに行って throw する。client component で
// 包めば props（locale / messages）だけで完結するため、plugin なし・cookie
// ベースの構成を保てる。register/mypage には先行する複製があるが、新規ページは
// route 配下でなく中立な app/i18n/ に置いたこの共有版を使う。
export function SonariIntlProvider({
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
