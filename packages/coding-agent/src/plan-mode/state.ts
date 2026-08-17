export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}

/** Lightweight collaboration mode: steering only, no tool/model/approval changes. */
export interface PlanLiteModeState {
	enabled: boolean;
}
