import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "indexd approval inbox",
    short_name: "indexd",
    description:
      "A human review inbox and workload control room. Approvals always require a live connection.",
    start_url: "/?app=review-queue",
    scope: "/",
    display: "standalone",
    background_color: "#efe1bf",
    theme_color: "#34271f",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
