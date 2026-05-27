export interface UsgsEarthquakeCandidate {
    source_event_id: string;
    requested_source_event_id?: string;
    occurred_at_ms: number;
    source_updated_at_ms: number;
    magnitude: number | null;
    summary_mmi: number | null;
    alert: UsgsAlertLevel | null;
    tsunami: boolean;
}

export type UsgsAlertLevel = "green" | "yellow" | "orange" | "red";

export interface UsgsSourceEventIdResolution {
    source_event_id: string;
    requested_source_event_id?: string;
}

export interface UsgsSourceEventIdUnavailableResolution {
    unavailable: true;
    source_event_id: string;
    error_code: "USGS_DETAIL_UNAVAILABLE";
}

export type UsgsSourceEventIdResolverResult =
    | UsgsSourceEventIdResolution
    | UsgsSourceEventIdUnavailableResolution;

export interface UsgsSourceEventIdResolverInput {
    sourceEventId: string;
}

export type UsgsSourceEventIdResolver = (
    input: UsgsSourceEventIdResolverInput,
) => Promise<UsgsSourceEventIdResolverResult | null>;

export const USGS_RECENT_FEED_URL =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";

export function usgsDetailUrl(sourceEventId: string): string {
    return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${sourceEventId}.geojson`;
}

export async function fetchUsgsRecentCandidates(
    fetcher: typeof fetch = fetch,
): Promise<UsgsEarthquakeCandidate[]> {
    const response = await fetcher(USGS_RECENT_FEED_URL);
    if (!response.ok) {
        throw new Error(`USGS recent feed unavailable: ${response.status}`);
    }
    return parseUsgsRecentFeed(await response.json());
}

export async function resolveUsgsSourceEventId(
    input: UsgsSourceEventIdResolverInput,
    fetcher: typeof fetch = fetch,
): Promise<UsgsSourceEventIdResolverResult | null> {
    const unavailable: UsgsSourceEventIdUnavailableResolution = {
        unavailable: true,
        source_event_id: input.sourceEventId,
        error_code: "USGS_DETAIL_UNAVAILABLE",
    };
    let response: Response;
    try {
        response = await fetcher(usgsDetailUrl(input.sourceEventId));
    } catch {
        return unavailable;
    }
    if (!response.ok) {
        return unavailable;
    }

    let detail: unknown;
    try {
        detail = await response.json();
    } catch {
        return unavailable;
    }
    const identity = parseUsgsDetailIdentity(detail);
    if (identity === null) {
        return unavailable;
    }
    if (identity.id === input.sourceEventId) {
        return { source_event_id: identity.id };
    }
    if (usgsIdsContains(identity.ids, input.sourceEventId)) {
        return {
            source_event_id: identity.id,
            requested_source_event_id: input.sourceEventId,
        };
    }
    return null;
}

export function parseUsgsRecentFeed(input: unknown): UsgsEarthquakeCandidate[] {
    if (!isRecord(input) || !Array.isArray(input.features)) {
        return [];
    }

    const candidates: UsgsEarthquakeCandidate[] = [];
    for (const feature of input.features) {
        const candidate = parseFeature(feature);
        if (candidate !== null) {
            candidates.push(candidate);
        }
    }
    return candidates;
}

function parseFeature(feature: unknown): UsgsEarthquakeCandidate | null {
    if (!isRecord(feature) || typeof feature.id !== "string" || !isRecord(feature.properties)) {
        return null;
    }

    if (feature.properties.type !== "earthquake") {
        return null;
    }

    const occurredAtMs = feature.properties.time;
    const sourceUpdatedAtMs = feature.properties.updated;
    if (!isUnixMs(occurredAtMs) || !isUnixMs(sourceUpdatedAtMs)) {
        return null;
    }

    const candidate: UsgsEarthquakeCandidate = {
        source_event_id: feature.id,
        occurred_at_ms: occurredAtMs,
        source_updated_at_ms: sourceUpdatedAtMs,
        magnitude: readFiniteNumber(feature.properties.mag),
        summary_mmi: readFiniteNumber(feature.properties.mmi),
        alert: readAlert(feature.properties.alert),
        tsunami: feature.properties.tsunami === 1,
    };
    return candidate;
}

function parseUsgsDetailIdentity(input: unknown): { id: string; ids: string | undefined } | null {
    if (!isRecord(input) || typeof input.id !== "string" || !isRecord(input.properties)) {
        return null;
    }
    return {
        id: input.id,
        ids: typeof input.properties.ids === "string" ? input.properties.ids : undefined,
    };
}

function usgsIdsContains(ids: string | undefined, sourceEventId: string): boolean {
    return (
        ids
            ?.split(",")
            .map((item) => item.trim())
            .some((item) => item === sourceEventId) ?? false
    );
}

function readFiniteNumber(input: unknown): number | null {
    return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function readAlert(input: unknown): UsgsAlertLevel | null {
    return input === "green" || input === "yellow" || input === "orange" || input === "red"
        ? input
        : null;
}

function isUnixMs(input: unknown): input is number {
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
