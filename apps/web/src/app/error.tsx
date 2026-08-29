"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="route-state" role="alert">
      <p className="eyebrow">Control room unavailable</p>
      <h1>indexd could not open this view</h1>
      <p>No operation was submitted. Try the request again after checking your connection.</p>
      <button className="route-state-action" type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
