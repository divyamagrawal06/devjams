import { describe, expect, test } from "bun:test";

import { type AllayCreateTemplate, findMentionedServer, parseAllayIntent } from "./allay-intent";

describe("parseAllayIntent", () => {
  test("recognizes conversational power commands", () => {
    expect(parseAllayIntent("Could you spin up Survival for me?")).toEqual({
      kind: "power",
      action: "start",
    });
    expect(parseAllayIntent("put the realm to sleep")).toEqual({
      kind: "power",
      action: "stop",
    });
    expect(parseAllayIntent("reboot it please")).toEqual({
      kind: "power",
      action: "restart",
    });
  });

  test("keeps informational requests separate from mutations", () => {
    expect(parseAllayIntent("is Creative online?")).toEqual({ kind: "status" });
    expect(parseAllayIntent("copy the join address")).toEqual({ kind: "copy" });
    expect(parseAllayIntent("show my realms")).toEqual({ kind: "list" });
    expect(parseAllayIntent("what can you do?")).toEqual({ kind: "help" });
  });

  test("normalizes a named Valheim create request", () => {
    expect(parseAllayIntent("create a valheim server named vikings")).toEqual({
      kind: "create",
      template: "valheim",
      body: {
        name: "vikings",
        game: "valheim",
        type: "linuxgsm",
        version: "rolling",
        cpuCores: 2,
        ramMb: 3072,
        storageGb: 10,
        gameConfigJson: {},
      },
    });
  });

  test("normalizes a Node website with a safe default file", () => {
    const intent = parseAllayIntent("host a node website called portfolio");
    expect(intent.kind).toBe("create");
    if (intent.kind !== "create") throw new Error("Expected a create intent");

    expect(intent.template).toBe("node_static");
    expect(intent.body).toMatchObject({
      name: "portfolio",
      game: "node",
      type: "static",
      version: "22",
      cpuCores: 1,
      ramMb: 512,
      storageGb: 2,
    });
    const files = intent.body.gameConfigJson.files as Record<string, unknown>;
    expect(typeof files["index.html"]).toBe("string");
    expect(files["index.html"]).toContain("<!doctype html>");
  });

  test.each([
    [
      "create a paper server named paper town",
      "minecraft_paper",
      "minecraft",
      "paper",
      "1.21.8",
      1,
      2048,
      5,
    ],
    [
      "make a vanilla minecraft realm called block party",
      "minecraft_vanilla",
      "minecraft",
      "vanilla",
      "1.21.8",
      1,
      2048,
      5,
    ],
    [
      "provision a bedrock server named pocket friends",
      "minecraft_bedrock",
      "minecraft_bedrock",
      "vanilla",
      "latest",
      1,
      1536,
      5,
    ],
    ["create a rust server called wipe day", "rust", "rust", "linuxgsm", "rolling", 2, 9216, 20],
    ["create a cs2 server called dust crew", "cs2", "cs2", "linuxgsm", "rolling", 2, 3072, 10],
    [
      "create a terraria world called moon lord",
      "terraria",
      "terraria",
      "linuxgsm",
      "rolling",
      1,
      2048,
      5,
    ],
    [
      "create a factorio server called main bus",
      "factorio",
      "factorio",
      "linuxgsm",
      "rolling",
      1,
      2048,
      5,
    ],
    [
      "create a project zomboid server called knox county",
      "project_zomboid",
      "project_zomboid",
      "linuxgsm",
      "rolling",
      2,
      3072,
      10,
    ],
  ])(
    "maps %s to the curated template",
    (prompt, template, game, type, version, cpuCores, ramMb, storageGb) => {
      const intent = parseAllayIntent(prompt as string);
      expect(intent.kind).toBe("create");
      if (intent.kind !== "create") throw new Error("Expected a create intent");

      expect(intent.template).toBe(template as AllayCreateTemplate);
      expect(intent.body).toMatchObject({
        game,
        type,
        version,
        cpuCores,
        ramMb,
        storageGb,
      });
    },
  );
});

describe("findMentionedServer", () => {
  const servers = [
    { id: "one", name: "Survival" },
    { id: "two", name: "Survival Two" },
    { id: "three", name: "Creative" },
  ];

  test("prefers the longest explicit realm name", () => {
    expect(findMentionedServer(servers, "wake Survival Two")?.id).toBe("two");
  });

  test("supports numbered choices", () => {
    expect(findMentionedServer(servers, "server 3")?.id).toBe("three");
  });

  test("only uses conversation context for a pronoun", () => {
    expect(findMentionedServer(servers, "restart it", "three")?.id).toBe("three");
    expect(findMentionedServer(servers, "restart a server", "three")).toBeNull();
  });

  test("selects the only available realm without clarification", () => {
    expect(findMentionedServer([servers[0]], "wake my realm")?.id).toBe("one");
  });
});
