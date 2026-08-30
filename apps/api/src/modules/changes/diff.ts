function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(value: unknown, path = "document", output = new Map<string, string>()) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      flatten(entry, `${path}[${index}]`, output);
    });
    if (value.length === 0) output.set(path, "[]");
    return output;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    entries.forEach(([key, child]) => {
      flatten(child, `${path}.${key}`, output);
    });
    if (entries.length === 0) output.set(path, "{}");
    return output;
  }
  output.set(path, JSON.stringify(value));
  return output;
}

export type ChangeDiffEntry = {
  kind: "added" | "removed" | "changed";
  path: string;
  before: string | null;
  after: string | null;
  summary: string;
};

/** Small, deterministic sentences for a review gate; never an opaque JSON patch. */
export function describeDocumentChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): ChangeDiffEntry[] {
  const previous = before ? flatten(before) : new Map<string, string>();
  const next = flatten(after);
  const paths = [...new Set([...previous.keys(), ...next.keys()])].sort();

  return paths
    .filter((path) => previous.get(path) !== next.get(path))
    .map((path) => {
      const oldValue = previous.get(path) ?? null;
      const newValue = next.get(path) ?? null;
      const label = path.replace(/^document\./, "");
      if (oldValue === null) {
        return {
          kind: "added" as const,
          path,
          before: null,
          after: newValue,
          summary: `${label} will be added as ${newValue}.`,
        };
      }
      if (newValue === null) {
        return {
          kind: "removed" as const,
          path,
          before: oldValue,
          after: null,
          summary: `${label} will be removed (was ${oldValue}).`,
        };
      }
      return {
        kind: "changed" as const,
        path,
        before: oldValue,
        after: newValue,
        summary: `${label} will change from ${oldValue} to ${newValue}.`,
      };
    });
}
