"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { API, api, session, type SyncState, type User } from "./api";

type Listener = (e: Record<string, unknown> & { type: string }) => void;
type Ctx = {
  user: User; sync: SyncState | null; nodeOnline: boolean; version: number;
  /** Crew member whose health data is in view (own record for astronauts). */
  crew: string; setCrew: (c: string) => void;
  subscribe: (fn: Listener) => () => void; refresh: () => void; logout: () => void;
};

const SessionCtx = createContext<Ctx | null>(null);

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}

export function SessionProvider({ user, children, onLogout }: { user: User; children: React.ReactNode; onLogout: () => void }) {
  const [sync, setSync] = useState<SyncState | null>(null);
  const [nodeOnline, setNodeOnline] = useState(false);
  const [version, setVersion] = useState(0);
  const [crew, setCrew] = useState(user.crewMemberId && user.role === "ASTRONAUT" ? user.crewMemberId : "CM-01");
  const listeners = useRef(new Set<Listener>());
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(session.token() ?? "")}`);
      ws.onopen = () => setNodeOnline(true);
      ws.onclose = () => {
        setNodeOnline(false);
        if (!closed) retry = setTimeout(open, 2000);
      };
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === "sync") setSync(e);
        // High-rate stream events go to subscribers only; everything else invalidates fetched data.
        if (e.type !== "sample" && e.type !== "cognitive_sample") setVersion((v) => v + 1);
        listeners.current.forEach((fn) => fn(e));
      };
    };
    open();
    // Client heartbeat: keeps proxies and idle-sleeping hosts (e.g. Render free) from dropping the link.
    const beat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 60_000);
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(beat);
      ws?.close();
    };
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  return (
    <SessionCtx.Provider value={{ user, sync, nodeOnline, version, crew, setCrew, subscribe, refresh, logout: onLogout }}>
      {children}
    </SessionCtx.Provider>
  );
}

/** GET `path`, re-fetched whenever the node pushes an invalidation event. */
export function useData<T>(path: string | null) {
  const { version } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, version]);
  return { data, error };
}
