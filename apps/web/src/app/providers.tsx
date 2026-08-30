"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import {
  purgeIndexdSessionStorage,
  SESSION_INVALIDATED_EVENT,
  sessionTransitionRequiresPurge,
} from "@/lib/session-lifecycle";

const OnlineContext = createContext(true);

function OnlineState({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(window.navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>;
}

function SessionLifecycle() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const redirecting = useRef(false);

  useEffect(() => {
    const invalidate = () => {
      if (redirecting.current) return;
      redirecting.current = true;
      queryClient.clear();
      purgeIndexdSessionStorage(window.sessionStorage);
      window.location.replace("/");
    };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate);
  }, [queryClient]);

  useEffect(() => {
    const nextUserId = session.data?.user.id ?? null;
    if (sessionTransitionRequiresPurge(previousUserId.current, nextUserId, session.isPending)) {
      window.dispatchEvent(new Event(SESSION_INVALIDATED_EVENT));
      return;
    }
    if (!session.isPending) previousUserId.current = nextUserId;
  }, [session.data?.user.id, session.isPending]);

  return null;
}

function StaticServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("Static service worker registration failed", {
        message: error instanceof Error ? error.message : "Unknown registration failure",
      });
    });
  }, []);
  return null;
}

export function useOnlineStatus() {
  return useContext(OnlineContext);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <SessionLifecycle />
      <StaticServiceWorker />
      <OnlineState>{children}</OnlineState>
    </QueryClientProvider>
  );
}
