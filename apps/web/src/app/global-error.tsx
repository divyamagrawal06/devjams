"use client";

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="route-state" role="alert">
          <p className="eyebrow">Control room interrupted</p>
          <h1>indexd could not recover this workspace</h1>
          <p>No operation was submitted by this error screen. Reload the authenticated view.</p>
          <button className="route-state-action" onClick={reset} type="button">
            Reload workspace
          </button>
        </main>
      </body>
    </html>
  );
}
