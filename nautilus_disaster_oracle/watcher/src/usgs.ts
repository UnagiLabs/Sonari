export interface UsgsEarthquakeCandidate {
    source_event_id: string;
    occurred_at_ms: number;
    source_updated_at_ms: number;
    magnitude: number | null;
    summary_mmi: number | null;
    alert: UsgsAlertLevel | null;
    tsunami: boolean;
    detail_url?: string;
}

export type UsgsAlertLevel = "green" | "yellow" | "orange" | "red";

export const USGS_RECENT_FEED_URL =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";

export async function fetchUsgsRecentCandidates(
    fetcher: typeof fetch = fetch,
): Promise<UsgsEarthquakeCandidate[]> {
    const response = await fetcher(USGS_RECENT_FEED_URL);
    if (!response.ok) {
        throw new Error(`USGS recent feed unavailable: ${response.status}`);
    }
    return parseUsgsRecentFeed(await response.json());
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
    const detailUrl = readNonEmptyString(feature.properties.detail);
    if (detailUrl !== undefined) {
        candidate.detail_url = detailUrl;
    }
    return candidate;
}

function readNonEmptyString(input: unknown): string | undefined {
    return typeof input === "string" && input.length > 0 ? input : undefined;
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
