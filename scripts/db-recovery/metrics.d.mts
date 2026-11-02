export declare const metricsQuery: string;
export declare function assertValidMetrics(report: unknown): void;
export declare function assertBackupSafe(report: unknown): void;
export declare function metricsMatch(source: unknown, restored: unknown): boolean;
export declare function parseMetrics(output: string): unknown;
