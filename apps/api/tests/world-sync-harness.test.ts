import { expect, test } from "bun:test";
import { join } from "node:path";

test("M1 candidate readiness identity regressions pass in the Python harness", async () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const testFile = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "infra",
    "k8s",
    "world-sync",
    "test_measure.py",
  );
  const child = Bun.spawn([python, testFile], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).toContain("Ran 4 tests");
  expect(exitCode).toBe(0);
});
