const USGS_SOURCE_EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,64}$/;

export function isValidUsgsSourceEventId(sourceEventId: string): boolean {
    return USGS_SOURCE_EVENT_ID_PATTERN.test(sourceEventId) && !sourceEventId.includes("__");
}

export function assertValidUsgsSourceEventId(sourceEventId: string): void {
    if (!isValidUsgsSourceEventId(sourceEventId)) {
        throw new Error("invalid source_event_id");
    }
}
