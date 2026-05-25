const USGS_SOURCE_EVENT_ID_PATTERN = /^[a-z]{2}[a-z0-9-]{6,32}$/;

export function isValidUsgsSourceEventId(sourceEventId: string): boolean {
    return USGS_SOURCE_EVENT_ID_PATTERN.test(sourceEventId);
}

export function assertValidUsgsSourceEventId(sourceEventId: string): void {
    if (!isValidUsgsSourceEventId(sourceEventId)) {
        throw new Error("invalid source_event_id");
    }
}
