export const workloadCatalogue = {
  observedAt: new Date(0).toISOString(),
  workloadKinds: [
    {
      id: "minecraft",
      label: "Minecraft Java",
      available: true,
      versionPolicy: "explicit_release",
      defaultVersion: "1.21.4",
      runtimes: [
        { id: "paper", label: "Paper", loaderVersionRequired: false },
        { id: "vanilla", label: "Vanilla", loaderVersionRequired: false },
        { id: "purpur", label: "Purpur", loaderVersionRequired: false },
        { id: "fabric", label: "Fabric", loaderVersionRequired: true },
        { id: "forge", label: "Forge", loaderVersionRequired: true },
      ],
    },
    {
      id: "dedicated_game",
      label: "Dedicated game",
      available: false,
      unavailableReason: "No dedicated-game provisioning connector is active.",
      runtimes: [],
    },
    {
      id: "node_service",
      label: "Node service",
      available: false,
      unavailableReason: "No Node service provisioning connector is active.",
      runtimes: [],
    },
    {
      id: "oci_container",
      label: "Bounded OCI container",
      available: false,
      unavailableReason: "No bounded-container provisioning connector is active.",
      runtimes: [],
    },
  ],
  constraints: {
    cpuCores: { min: 1, max: 16 },
    ramMb: { min: 512, max: 32_768, step: 512 },
    storageGb: { min: 2, max: 500 },
  },
} as const;
