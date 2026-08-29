import Link from "next/link";

export default function NotFound() {
  return (
    <main className="route-state">
      <p className="eyebrow">Not found</p>
      <h1>This control-room view does not exist</h1>
      <p>The address may be outdated. Your workloads were not changed.</p>
      <Link className="route-state-action" href="/">
        Return to indexd
      </Link>
    </main>
  );
}
