import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { LoginScreen } from "@/components/login-screen";
import { getAuth } from "@/lib/auth";

import "./globals.css";
import { Providers } from "./providers";

const monocraft = localFont({
  display: "swap",
  preload: true,
  src: "../../public/fonts/Monocraft.ttf",
  variable: "--font-monocraft",
});

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "indexd | Workload control room",
  description:
    "A private control room for game servers, Node services, and bounded container workloads.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "indexd",
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  let session = null;

  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (error) {
    console.error("Unable to read the indexd session", {
      message: error instanceof Error ? error.message : "Unknown authentication error",
    });
  }

  return (
    <html className={monocraft.variable} lang="en">
      <body>{session ? <Providers>{children}</Providers> : <LoginScreen />}</body>
    </html>
  );
}
