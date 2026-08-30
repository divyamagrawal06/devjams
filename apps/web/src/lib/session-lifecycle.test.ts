import { describe, expect, test } from "bun:test";

import { purgeIndexdSessionStorage, sessionTransitionRequiresPurge } from "./session-lifecycle";

describe("session lifecycle", () => {
  test("purges only after an authenticated identity is lost or replaced", () => {
    expect(sessionTransitionRequiresPurge(undefined, null, false)).toBe(false);
    expect(sessionTransitionRequiresPurge("user-a", null, true)).toBe(false);
    expect(sessionTransitionRequiresPurge("user-a", "user-a", false)).toBe(false);
    expect(sessionTransitionRequiresPurge("user-a", null, false)).toBe(true);
    expect(sessionTransitionRequiresPurge("user-a", "user-b", false)).toBe(true);
  });

  test("removes indexd operation keys without touching unrelated session state", () => {
    const values = new Map([
      ["indexd:power:one:start", "request-one"],
      ["indexd:billing-checkout:pro", "request-two"],
      ["another-app:draft", "keep-me"],
    ]);
    const storage = {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][index] ?? null;
      },
      removeItem(key: string) {
        values.delete(key);
      },
    };

    expect(purgeIndexdSessionStorage(storage)).toEqual([
      "indexd:power:one:start",
      "indexd:billing-checkout:pro",
    ]);
    expect([...values.entries()]).toEqual([["another-app:draft", "keep-me"]]);
  });
});
