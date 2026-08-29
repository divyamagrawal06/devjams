export type AllayPowerAction = "start" | "stop" | "restart";

export type AllayCreateTemplate =
  | "minecraft_paper"
  | "minecraft_vanilla"
  | "minecraft_bedrock"
  | "rust"
  | "cs2"
  | "valheim"
  | "terraria"
  | "factorio"
  | "project_zomboid"
  | "node_static";

export type CreateWorkloadBody = {
  name: string;
  game: string;
  type: string;
  version: string;
  cpuCores: number;
  ramMb: number;
  storageGb: number;
  gameConfigJson: Record<string, unknown>;
};

export type AllayCreateIntent = {
  kind: "create";
  template: AllayCreateTemplate;
  body: CreateWorkloadBody;
};

export type AllayIntent =
  | { kind: "greeting" }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "copy" }
  | { kind: "power"; action: AllayPowerAction }
  | AllayCreateIntent
  | { kind: "unknown" };

type NamedServer = {
  id: string;
  name: string;
};

type CreateTemplateDefinition = {
  id: AllayCreateTemplate;
  label: string;
  aliases: string[];
  defaultName: string;
  body: Omit<CreateWorkloadBody, "name">;
};

const DEFAULT_NODE_INDEX =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My site</title></head><body><main><h1>Your Node site is live.</h1><p>Edit index.html to make it yours.</p></main></body></html>';

const MINECRAFT_CONFIG = {
  maxPlayers: 20,
  difficulty: "normal",
  pvp: true,
};

const CREATE_TEMPLATES: CreateTemplateDefinition[] = [
  {
    id: "minecraft_bedrock",
    label: "Minecraft Bedrock",
    aliases: ["minecraft bedrock", "bedrock minecraft", "bedrock server", "bedrock realm"],
    defaultName: "Bedrock Realm",
    body: {
      game: "minecraft_bedrock",
      type: "vanilla",
      version: "latest",
      cpuCores: 1,
      ramMb: 1536,
      storageGb: 5,
      gameConfigJson: { maxPlayers: 20 },
    },
  },
  {
    id: "minecraft_vanilla",
    label: "Minecraft Vanilla",
    aliases: ["minecraft vanilla", "vanilla minecraft", "vanilla server", "vanilla realm"],
    defaultName: "Vanilla Realm",
    body: {
      game: "minecraft",
      type: "vanilla",
      version: "1.21.8",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: MINECRAFT_CONFIG,
    },
  },
  {
    id: "minecraft_paper",
    label: "Minecraft Paper",
    aliases: [
      "minecraft paper",
      "paper minecraft",
      "paper server",
      "paper realm",
      "minecraft server",
      "minecraft realm",
      "minecraft",
    ],
    defaultName: "Minecraft Realm",
    body: {
      game: "minecraft",
      type: "paper",
      version: "1.21.8",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: MINECRAFT_CONFIG,
    },
  },
  {
    id: "project_zomboid",
    label: "Project Zomboid",
    aliases: ["project zomboid", "zomboid server", "zomboid"],
    defaultName: "Project Zomboid Server",
    body: {
      game: "project_zomboid",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 2,
      ramMb: 3072,
      storageGb: 10,
      gameConfigJson: {},
    },
  },
  {
    id: "valheim",
    label: "Valheim",
    aliases: ["valheim server", "valheim world", "valheim"],
    defaultName: "Valheim Server",
    body: {
      game: "valheim",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 2,
      ramMb: 3072,
      storageGb: 10,
      gameConfigJson: {},
    },
  },
  {
    id: "terraria",
    label: "Terraria",
    aliases: ["terraria server", "terraria world", "terraria"],
    defaultName: "Terraria Server",
    body: {
      game: "terraria",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: {},
    },
  },
  {
    id: "factorio",
    label: "Factorio",
    aliases: ["factorio server", "factorio world", "factorio"],
    defaultName: "Factorio Server",
    body: {
      game: "factorio",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 1,
      ramMb: 2048,
      storageGb: 5,
      gameConfigJson: {},
    },
  },
  {
    id: "rust",
    label: "Rust",
    aliases: ["rust server", "rust world", "rust"],
    defaultName: "Rust Server",
    body: {
      game: "rust",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 2,
      ramMb: 9216,
      storageGb: 20,
      gameConfigJson: {},
    },
  },
  {
    id: "cs2",
    label: "Counter-Strike 2",
    aliases: ["counter strike 2", "counterstrike 2", "cs 2", "cs2 server", "cs2"],
    defaultName: "CS2 Server",
    body: {
      game: "cs2",
      type: "linuxgsm",
      version: "rolling",
      cpuCores: 2,
      ramMb: 3072,
      storageGb: 10,
      gameConfigJson: {},
    },
  },
  {
    id: "node_static",
    label: "Node static site",
    aliases: [
      "node static site",
      "node js website",
      "node js site",
      "node website",
      "node site",
      "static website",
      "static site",
      "website",
    ],
    defaultName: "Node Site",
    body: {
      game: "node",
      type: "static",
      version: "22",
      cpuCores: 1,
      ramMb: 512,
      storageGb: 2,
      gameConfigJson: {
        files: {
          "index.html": DEFAULT_NODE_INDEX,
        },
      },
    },
  },
];

const CREATE_PHRASES = [
  "create",
  "make",
  "provision",
  "deploy",
  "host",
  "set up",
  "spin up",
  "launch",
  "new",
];

function normalize(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function containsPhrase(input: string, phrases: string[]) {
  return phrases.some((phrase) =>
    new RegExp(`\\b${escapeRegExp(phrase).replaceAll(" ", "\\s+")}\\b`, "i").test(input),
  );
}

function createName(value: string, fallback: string): string {
  const match = value.match(/\b(?:named|called|name\s+it)\s+["'“”]?(.+?)["'“”]?\s*[.!?]*$/i);
  const requested = match?.[1]
    ?.replace(/\s+(?:please|for me)$/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return (requested || fallback).replace(/\s+/g, " ").slice(0, 50);
}

function parseCreateIntent(value: string, input: string): AllayCreateIntent | null {
  if (!containsPhrase(input, CREATE_PHRASES)) return null;

  const template = CREATE_TEMPLATES.find((candidate) => containsPhrase(input, candidate.aliases));
  if (!template) return null;

  return {
    kind: "create",
    template: template.id,
    body: {
      name: createName(value, template.defaultName),
      ...template.body,
    },
  };
}

export function createTemplateLabel(template: AllayCreateTemplate): string {
  return CREATE_TEMPLATES.find((candidate) => candidate.id === template)?.label ?? "workload";
}

export function parseAllayIntent(value: string): AllayIntent {
  const input = normalize(value);

  if (!input) return { kind: "unknown" };

  const createIntent = parseCreateIntent(value, input);
  if (createIntent) return createIntent;

  if (containsPhrase(input, ["restart", "reboot", "cycle", "re launch", "relaunch"])) {
    return { kind: "power", action: "restart" };
  }

  if (
    containsPhrase(input, [
      "stop",
      "sleep",
      "shut down",
      "shutdown",
      "turn off",
      "power off",
      "take offline",
    ])
  ) {
    return { kind: "power", action: "stop" };
  }

  if (
    containsPhrase(input, [
      "start",
      "wake",
      "boot",
      "spin up",
      "turn on",
      "power on",
      "bring online",
    ])
  ) {
    return { kind: "power", action: "start" };
  }

  if (
    containsPhrase(input, [
      "copy",
      "address",
      "join code",
      "join link",
      "hostname",
      "ip",
      "url",
      "endpoint",
    ])
  ) {
    return { kind: "copy" };
  }

  if (
    containsPhrase(input, ["status", "state", "health", "online", "offline", "running", "how is"])
  ) {
    return { kind: "status" };
  }

  if (
    containsPhrase(input, [
      "list",
      "show realms",
      "show servers",
      "show sites",
      "show workloads",
      "my realms",
      "my servers",
      "my sites",
      "my workloads",
    ])
  ) {
    return { kind: "list" };
  }

  if (containsPhrase(input, ["help", "commands", "what can you do", "options"])) {
    return { kind: "help" };
  }

  if (containsPhrase(input, ["hi", "hello", "hey", "allay", "thanks", "thank you"])) {
    return { kind: "greeting" };
  }

  return { kind: "unknown" };
}

export function findMentionedServer<T extends NamedServer>(
  servers: T[],
  value: string,
  fallbackServerId?: string | null,
): T | null {
  if (servers.length === 0) return null;
  if (servers.length === 1) return servers[0];

  const input = normalize(value);
  const mentioned = [...servers]
    .sort((a, b) => b.name.length - a.name.length)
    .find((server) => {
      const name = normalize(server.name);
      return (
        name.length > 0 && new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:$|\\s)`, "i").test(input)
      );
    });

  if (mentioned) return mentioned;

  const ordinal = input.match(/\b(?:realm|server|site|workload)?\s*(\d+)\b/);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (servers[index]) return servers[index];
  }

  const usesContext = containsPhrase(input, [
    "it",
    "that one",
    "that realm",
    "that server",
    "that site",
    "that workload",
    "the realm",
    "the server",
    "the site",
    "the workload",
  ]);

  if (usesContext && fallbackServerId) {
    return servers.find((server) => server.id === fallbackServerId) ?? null;
  }

  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
