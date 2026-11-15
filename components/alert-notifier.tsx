"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, BellRing, Send } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, isMedical } from "@/lib/api";
import { useSession } from "@/lib/session";
import { StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type AlertEvent = { id: string; crew_member_id: string | null; category: string; severity: string; title: string; summary: string | null; created_at: string };

const seenKey = (userId: string) => `astra.alerts.seen.${userId}`;
const readSeen = (userId: string) => { try { return localStorage.getItem(seenKey(userId)) ?? ""; } catch { return ""; } };

/**
 * In-app alert inbox. Loads open alerts on sign-in (so nothing raised while you were away is missed),
 * then adds each new alert pushed by the node in real time with a toast. Unread = newer than your last look.
 */
export function AlertNotifier() {
  const { user, subscribe } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<AlertEvent[]>([]);
  const [seen, setSeen] = useState("");
  const unseen = items.filter((a) => a.created_at > seen).length;

  useEffect(() => {
    setSeen(readSeen(user.id)); // eslint-disable-line react-hooks/set-state-in-effect
    api<(AlertEvent & { explanation?: { summary?: string } })[]>("/alerts?status=OPEN")
      .then((rows) => setItems((live) => {
        const known = new Set(live.map((a) => a.id));
        return [...live, ...rows.filter((r) => !known.has(r.id)).map((r) => ({ ...r, summary: r.explanation?.summary ?? null }))].slice(0, 30);
      }))
      .catch(() => {});
  }, [user.id]);

  function markSeen() {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    setSeen(now);
    try { localStorage.setItem(seenKey(user.id), now); } catch { /* private mode: unread resets on reload */ }
  }
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  useEffect(() => {
    if ("Notification" in window) setPermission(Notification.permission); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  useEffect(() => subscribe((e) => {
    if (e.type !== "alert.new") return;
    const a = e as unknown as AlertEvent;
    setItems((x) => [a, ...x.filter((y) => y.id !== a.id)].slice(0, 30));
    const who = a.crew_member_id ?? "Station";
    const show = a.severity === "HIGH" || a.severity === "CRITICAL" ? toast.error : toast.warning;
    show(`${who} · ${a.title}`, {
      description: a.summary ?? undefined, duration: 12000,
      action: { label: "Open", onClick: () => router.push("/alerts") },
    });
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      const n = new Notification(`ASTRA · ${who}`, { body: a.title, tag: a.id });
      n.onclick = () => { window.focus(); router.push("/alerts"); };
    }
  }), [subscribe, router]);

  const canTest = isMedical(user.role) || user.role === "MISSION_OPERATOR";

  return (
    <DropdownMenu onOpenChange={(o) => o && markSeen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={`Notifications${unseen ? `, ${unseen} new` : ""}`}>
          {unseen ? <BellRing className="text-warning-strong" /> : <Bell />}
          {unseen > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive font-mono text-[9px] font-bold text-white">
              {unseen > 9 ? "9+" : unseen}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Open alerts · live</DropdownMenuLabel>
        {!items.length && <p className="px-2 py-3 text-sm text-muted-foreground">No open alerts.</p>}
        {items.slice(0, 12).map((a) => (
          <DropdownMenuItem key={a.id} onClick={() => router.push("/alerts")} className="flex flex-col items-start gap-0.5">
            <span className="flex w-full items-center gap-2">
              <StatusBadge value={a.severity} />
              <span className="font-mono text-[11px] text-muted-foreground">{a.crew_member_id ?? "station"} · {fmtDate(a.created_at)}</span>
            </span>
            <span className="text-sm">{a.title}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {permission === "default" && (
          <DropdownMenuItem onClick={async () => setPermission(await Notification.requestPermission())}>
            <BellRing />Enable desktop notifications
          </DropdownMenuItem>
        )}
        {permission === "denied" && <p className="px-2 py-1.5 text-xs text-muted-foreground">Desktop notifications are blocked in this browser.</p>}
        {canTest && (
          <DropdownMenuItem onClick={() => api("/notifications/test", { method: "POST" }).then(() => toast.message("Test alert raised")).catch((x) => toast.error(x.message))}>
            <Send />Send test notification
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
