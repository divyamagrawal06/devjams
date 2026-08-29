import type { VelocityTransfer, VelocityTransferAck } from "@farlands/contracts";

import { transferService } from "./transfers-durable";

export * from "./transfers-durable";

export function issueTransfer(input: {
  deploymentId: string;
  fromRoute: string;
  toRoute: string;
  message: string;
  sourcePlayers: string[];
  expiresInMs?: number;
}): Promise<string> {
  return transferService.issue(input);
}

export function listPendingTransfers(): Promise<VelocityTransfer[]> {
  return transferService.listPending();
}

export function ackTransfer(id: string, ack: VelocityTransferAck): Promise<VelocityTransferAck> {
  return transferService.acknowledge(id, ack);
}

export function waitForAck(id: string, timeoutMs = 60_000): Promise<VelocityTransferAck> {
  return transferService.waitForAck(id, timeoutMs);
}
