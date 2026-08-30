import { describe, expect, test } from "bun:test";

import { workloadManifestTestUtils } from "../src/modules/provisioning/service";
import { buildWorldSyncSenderScript } from "../src/modules/provisioning/tenancy";

const names = {
  pvc: "pvc-server-test",
  deployment: "deploy-server-test",
  service: "svc-server-test",
  secret: "secret-server-test",
  configMap: "cm-server-test",
  filesConfigMap: "cm-server-test-files",
  networkPolicy: "netpol-server-test",
};

const labels = {
  "app.kubernetes.io/name": "farlands-game-server",
  "app.kubernetes.io/managed-by": "farlands-backend",
  "farlands.dev/server-id": "server-test",
  "farlands.dev/runtime": "paper",
  "farlands.dev/backup-strategy": "minecraft-rcon",
};

describe("application-consistent world backup stream", () => {
  test("is valid Python and always restores Minecraft saving", async () => {
    const script = buildWorldSyncSenderScript();
    const check = Bun.spawn(
      ["python", "-c", "import sys; compile(sys.stdin.read(), '<world-sync>', 'exec')"],
      {
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await check.exited;
    const error = await new Response(check.stderr).text();

    expect(error).toBe("");
    expect(exitCode).toBe(0);
    expect(script).toContain('client.send("save-off")');
    expect(script).toContain('client.send("save-all flush")');
    expect(script).toContain('client.send("save-on")');
    expect(script).toContain('self.send_header("Transfer-Encoding", "chunked")');
    expect(script).toContain("restore_saves(client)");
    expect(script).toContain('self.wfile.write(b"0\\r\\n\\r\\n")');
    expect(script).toContain("os._exit(1)");
    expect(script).toContain("recover_saves_on_startup");
    expect(script).not.toContain("Thread(target=recover_saves_on_startup");
    expect(
      script.indexOf("recover_saves_on_startup()\nhttp.server.ThreadingHTTPServer"),
    ).toBeGreaterThan(script.indexOf("class Handler"));
  });

  test("restricts the backup sidecar and its network path", () => {
    const previousImage = process.env.FARLANDS_WORLD_SYNC_IMAGE;
    process.env.FARLANDS_WORLD_SYNC_IMAGE = `python:3.12-alpine@sha256:${"a".repeat(64)}`;
    const resources = workloadManifestTestUtils.buildResourceSpec("1", 1024);
    const deployment = workloadManifestTestUtils.buildDeployment(
      "fl-user",
      names,
      labels,
      `itzg/minecraft-server@sha256:${"a".repeat(64)}`,
      resources,
    );
    const podSpec = deployment.spec?.template.spec!;
    const sidecar = podSpec.containers.find((container) => container.name === "world-sync")!;
    const service = workloadManifestTestUtils.buildService("fl-user", names, labels);
    const policy = workloadManifestTestUtils.buildNetworkPolicy("fl-user", names, labels);

    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(sidecar.image).toContain("@sha256:");
    expect(sidecar.command).toEqual(["python3", "/sync/sender.py"]);
    expect(sidecar.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(sidecar.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    expect(sidecar.volumeMounts?.find((mount) => mount.name === "server-data")?.readOnly).toBe(
      true,
    );
    expect(service.spec?.selector?.["app.kubernetes.io/name"]).toBe("farlands-game-server");
    const worldSyncIngress = policy.spec?.ingress?.[2] as unknown as {
      from?: Array<{ podSelector?: { matchLabels?: { app?: string } } }>;
    };
    expect(worldSyncIngress.from?.[0]?.podSelector?.matchLabels?.app).toBe("server-backup-worker");
    if (previousImage === undefined) delete process.env.FARLANDS_WORLD_SYNC_IMAGE;
    else process.env.FARLANDS_WORLD_SYNC_IMAGE = previousImage;
  });
});
