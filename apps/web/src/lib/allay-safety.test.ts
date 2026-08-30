import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const companionSource = readFileSync(
  new URL("../components/allay-companion.tsx", import.meta.url),
  "utf8",
);

describe("Allay mutation gates", () => {
  test("keeps ambiguous replies inside a pending power confirmation", () => {
    const confirmationGate = companionSource.match(
      /if \(pendingConfirmation\) \{([\s\S]*?)\n {4}\}\n\n {4}if \(pendingSelection\)/,
    )?.[1];

    expect(confirmationGate).toBeDefined();
    expect(confirmationGate).toContain(
      'appendMessage("allay", "Please confirm or cancel the pending power request first.");',
    );
    expect(confirmationGate).toMatch(
      /Please confirm or cancel the pending power request first\."\);\s*return;\s*$/,
    );
  });
});
