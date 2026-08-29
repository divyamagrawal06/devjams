import AdmZip from "adm-zip";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

/**
 * Inject a validated config into the pinned interpreter JAR. Every ZIP entry
 * receives a fixed timestamp so the same document plus runtime produces the
 * same bytes and therefore the same deployable-artifact digest.
 */
export function buildPluginJar(
  pluginName: string,
  yamlContent: string,
  runtimeJar: Uint8Array,
  minecraftVersion: string,
): Buffer {
  const zip = new AdmZip(Buffer.from(runtimeJar));

  zip.deleteFile("config.yml");
  zip.addFile("config.yml", Buffer.from(yamlContent, "utf8"));

  const apiVersion = minecraftVersion.split(".").slice(0, 2).join(".");
  const pluginYml = [
    `name: ${pluginName}`,
    "version: 1.0.0",
    "main: com.farlands.PluginMain",
    `api-version: ${apiVersion}`,
  ].join("\n");

  zip.deleteFile("plugin.yml");
  zip.addFile("plugin.yml", Buffer.from(pluginYml.trim(), "utf8"));

  for (const entry of zip.getEntries()) {
    entry.header.time = ZIP_EPOCH;
  }

  return zip.toBuffer();
}
