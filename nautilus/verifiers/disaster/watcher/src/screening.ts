import type { OffchainStatus, OracleErrorCode } from "@sonari/oracle-shared";
import type { UsgsAlertLevel, UsgsEarthquakeCandidate } from "./usgs.js";

export const WATCHER_MIN_MAGNITUDE = 5.5;
export const WATCHER_MIN_SUMMARY_MMI = 6.0;
export const WATCHER_ALERT_LEVELS = [
    "yellow",
    "orange",
    "red",
] as const satisfies readonly UsgsAlertLevel[];

export interface UsgsCandidateScreeningResult {
    runnerEligible: boolean;
    status: Extract<OffchainStatus, "new" | "ignored_small">;
    error_code: Extract<OracleErrorCode, "WATCHER_BELOW_AUTO_THRESHOLD"> | null;
}

export function screenUsgsCandidate(
    candidate: UsgsEarthquakeCandidate,
): UsgsCandidateScreeningResult {
    const runnerEligible =
        (candidate.magnitude !== null && candidate.magnitude >= WATCHER_MIN_MAGNITUDE) ||
        (candidate.summary_mmi !== null && candidate.summary_mmi >= WATCHER_MIN_SUMMARY_MMI) ||
        (candidate.alert !== null &&
            WATCHER_ALERT_LEVELS.some((alertLevel) => alertLevel === candidate.alert)) ||
        candidate.tsunami;

    return runnerEligible
        ? { runnerEligible, status: "new", error_code: null }
        : {
              runnerEligible,
              status: "ignored_small",
              error_code: "WATCHER_BELOW_AUTO_THRESHOLD",
          };
}
