export type ConfidenceLevel = "low" | "medium" | "high";

export type RiskBucket = "low" | "medium" | "high";

export interface ResidenceEvidenceSnapshot {
    readonly verifier: "residence";
    readonly subjectId: string;
    readonly confidence: ConfidenceLevel;
    readonly riskBucket: RiskBucket;
}

export interface ResidenceMetadataUpdate {
    readonly verifier: "residence";
    readonly subjectId: string;
    readonly confidence: ConfidenceLevel;
    readonly riskBucket: RiskBucket;
}

export interface StudentEvidenceSnapshot {
    readonly verifier: "student";
    readonly subjectId: string;
    readonly confidence: ConfidenceLevel;
    readonly riskBucket: RiskBucket;
}

export interface StudentMetadataUpdate {
    readonly verifier: "student";
    readonly subjectId: string;
    readonly confidence: ConfidenceLevel;
    readonly riskBucket: RiskBucket;
}
