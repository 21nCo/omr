export const PHASE_00_SCENARIOS = [
  "accepts-the-dedicated-superfunctions-worktree",
  "rejects-a-package-name-or-path-mismatch",
  "records-the-upstream-base-commit",
  "keeps-conduct-outside-the-repository-contract",
] as const;

export type Phase00Scenario = (typeof PHASE_00_SCENARIOS)[number];
