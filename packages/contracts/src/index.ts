export const DEPLOYMENT_STATES = [
  "queued",
  "building",
  "staging",
  "presync",
  "freezing",
  "verifying",
  "cutover",
  "draining",
  "idle",
  "aborted",
  "failed",
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export const PRE_CUTOVER_STATES = [
  "queued",
  "building",
  "staging",
  "presync",
  "freezing",
  "verifying",
] as const;

export type PreCutoverState = (typeof PRE_CUTOVER_STATES)[number];

export type VelocityTransfer = {
  transferId: string;
  fromRoute: string;
  toRoute: string;
  message: string;
};

export type VelocityTransferAck = {
  movedPlayers: string[];
  failures: Array<{ player: string; reason: string }>;
};

export type DeployRequest = {
  ruleSetVersion: string;
  approvalToken: string;
};

export type DeploymentView = {
  id: string;
  serverId: string;
  state: DeploymentState;
  queuePosition: number | null;
  candidatePod: string | null;
  snapshotId: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type DeploymentEvent = {
  type: "deployment.state";
  deploymentId: string;
  serverId: string;
  state: DeploymentState;
  queuePosition: number | null;
  at: string;
};
