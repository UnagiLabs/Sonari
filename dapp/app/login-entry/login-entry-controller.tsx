"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { consumeLoginNext, saveLoginNext } from "./login-next";

export function LoginEntryController() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const account = useCurrentAccount();
    const redirectedAfterConnectRef = useRef(false);
    const hasNextParam = searchParams.has("next");
    const rawNext = searchParams.get("next");

    useEffect(() => {
        if (!hasNextParam) {
            return;
        }

        saveLoginNext(window.sessionStorage, rawNext);
        router.replace("/");
    }, [hasNextParam, rawNext, router]);

    useEffect(() => {
        if (!account || hasNextParam || redirectedAfterConnectRef.current) {
            return;
        }

        const next = consumeLoginNext(window.sessionStorage);
        if (next === null) {
            return;
        }

        redirectedAfterConnectRef.current = true;
        router.replace(next);
    }, [account, hasNextParam, router]);

    return null;
}
