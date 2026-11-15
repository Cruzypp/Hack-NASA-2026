"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Activity, BellRing, CalendarClock, ChevronsUpDown, Dumbbell, PersonStanding, FileHeart, HeartPulse, LayoutDashboard, LogOut, Orbit, RadioTower, Satellite, Stethoscope } from "lucide-react";
import { api, isMedical, session, type User } from "@/lib/api";
import { SessionProvider, useData, useSession } from "@/lib/session";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/labels";

const NAV = [
  { group: "Health", items: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, ops: true },
    { href: "/schedule", label: "Schedule", icon: CalendarClock, ops: true },
    { href: "/measurements", label: "Measurements", icon: HeartPulse },
    { href: "/exercise", label: "Exercise & Recovery", icon: Dumbbell },
    { href: "/body", label: "Body Composition", icon: PersonStanding },
  ] },
  { group: "Clinical", items: [
    { href: "/crew", label: "Crew Health", icon: Stethoscope, medical: true },
    { href: "/alerts", label: "Alerts & Follow-ups", icon: BellRing, ops: true, medical: true },
    { href: "/records", label: "Health Records", icon: FileHeart },
  ] },
  { group: "Systems", items: [
    { href: "/devices", label: "Devices & Sync", icon: RadioTower, ops: true, sync: true },
  ] },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!session.token()) return router.replace("/");
    api<User>("/me").then(setUser).catch(() => { session.clear(); router.replace("/"); });
  }, [router]);

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 font-mono text-sm text-muted-foreground">
        <Orbit className="size-4 animate-spin" /> Connecting to onboard node…
      </div>
    );
  }
  const logout = () => { session.clear(); router.replace("/"); };
  return (
    <SessionProvider user={user} onLogout={logout}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="bg-transparent">
          <TopBar />
          <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 md:p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  );
}

function AppSidebar() {
  const { user, sync, logout } = useSession();
  const path = usePathname();
  const initials = user.name.replace(/^Dr\.\s*/, "").split(/[\s.]+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("");
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Satellite className="size-4" /></div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="font-mono text-xs font-semibold tracking-[0.25em] text-primary">ASTRA</span>
                  <span className="truncate text-xs text-muted-foreground">Health · onboard node</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((g) => {
          const items = g.items.filter((n) =>
            (user.role !== "MISSION_OPERATOR" || ("ops" in n && n.ops)) &&
            (!("medical" in n) || isMedical(user.role) || user.role === "MISSION_OPERATOR"));
          if (!items.length) return null;
          return (
            <SidebarGroup key={g.group}>
              <SidebarGroupLabel>{g.group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((n) => (
                    <SidebarMenuItem key={n.href}>
                      <SidebarMenuButton asChild isActive={path === n.href} tooltip={n.label}>
                        <Link href={n.href}><n.icon /><span>{n.label}</span></Link>
                      </SidebarMenuButton>
                      {"sync" in n && sync && sync.pending > 0 && <SidebarMenuBadge className="font-mono text-warning-strong">{sync.pending}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <Avatar className="size-8 rounded-lg"><AvatarFallback className="rounded-lg bg-secondary font-mono text-xs">{initials}</AvatarFallback></Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{roleLabel(user.role)}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="font-mono text-xs text-muted-foreground">{user.crewMemberId ?? "Ground staff"} · {user.id}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}><LogOut />Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function TopBar() {
  const { user, sync, nodeOnline, crew, setCrew } = useSession();
  const roster = useData<{ crew_member_id: string; display_name: string }[]>(isMedical(user.role) ? "/crew" : null);
  const [busy, setBusy] = useState(false);
  const aos = sync?.link === "AOS";

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const r = await api<{ sent: number; pending: number }>("/sync/link", { body: { state: next ? "AOS" : "LOS" } });
      if (next) toast.success("Acquisition of signal", { description: `${r.sent} events replicated to ground, ${r.pending} pending.` });
      else toast.warning("Loss of signal", { description: "Onboard node continues; changes queue in the outbox." });
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-4!" />
      <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn("flex items-center gap-1.5", nodeOnline ? "text-success" : "text-destructive")}>
              <Activity className="size-3.5" />{nodeOnline ? "NODE LIVE" : "NODE UNREACHABLE"}
            </span>
          </TooltipTrigger>
          <TooltipContent>Realtime WebSocket to the onboard ASTRA node</TooltipContent>
        </Tooltip>
        {sync && (
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex items-center gap-2">
                <span className={aos ? "text-success" : "text-warning-strong"}>GROUND {sync.link}</span>
                <Switch checked={aos} disabled={busy} onCheckedChange={toggle} aria-label="Simulate ground link" />
                <span className="text-muted-foreground">outbox {sync.pending}</span>
              </label>
            </TooltipTrigger>
            <TooltipContent>Demo control: simulate loss / acquisition of signal with ground</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isMedical(user.role) && (
        <Select value={crew} onValueChange={setCrew}>
          <SelectTrigger size="sm" className="w-36 font-mono text-xs" aria-label="Crew member in view"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(roster.data ?? [{ crew_member_id: crew, display_name: "" }]).map((c) => (
              <SelectItem key={c.crew_member_id} value={c.crew_member_id}>{c.crew_member_id}{c.display_name && ` · ${c.display_name.replace(/^Dr\.\s*/, "").split(/\s+/).at(-1)}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </header>
  );
}
