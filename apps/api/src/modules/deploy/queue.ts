import { randomUUID } from "node:crypto";

import { type DeploymentStore, deploymentStore } from "./store";

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class DurableDeploymentQueue {
  readonly workerId: string;
  private readonly maxConcurrent: number;
  private readonly leaseMs: number;

  constructor(
    private readonly store: DeploymentStore = deploymentStore,
    options: { workerId?: string; maxConcurrent?: number; leaseMs?: number } = {},
  ) {
    this.workerId = options.workerId ?? `worker_${randomUUID()}`;
    this.maxConcurrent =
      options.maxConcurrent ??
      positiveInteger(process.env.DEPLOY_CONCURRENCY, DEFAULT_MAX_CONCURRENT);
    this.leaseMs =
      options.leaseMs ?? positiveInteger(process.env.DEPLOY_LEASE_MS, DEFAULT_LEASE_MS);
  }

  position(id: string): Promise<number | null> {
    return this.store.queuePosition(id);
  }

  claimNext(): Promise<string | null> {
    return this.store.claimNext(this.workerId, this.maxConcurrent, this.leaseMs);
  }

  renew(id: string): Promise<boolean> {
    return this.store.renewLease(id, this.workerId, this.leaseMs);
  }

  complete(id: string): Promise<void> {
    return this.store.completeQueue(id);
  }
}

export const deploymentQueue = new DurableDeploymentQueue();
