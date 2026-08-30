export type OperatorReceiptStatus = "accepted" | "completed" | "refused" | "failed";

export function operatorReceiptOutcome(status: OperatorReceiptStatus) {
  return {
    clearRequestKey: status === "completed",
    completed: status === "completed",
    pending: status === "accepted",
    retryable: status === "failed" || status === "refused",
  };
}
