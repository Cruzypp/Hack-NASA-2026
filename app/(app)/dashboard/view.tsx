"use client";

import Link from "next/link";
import { BellRing, CalendarCheck, CloudUpload, Cpu, Moon, HeartPulse, Radiation, Scale, X } from "lucide-react";
import { metricLabel } from "@/lib/labels";
import { toast } from "sonner";
import { api, fmtDate, fmtTime, type Alert, type Measurement, type RadiationBrief, type SyncState, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { AlertCard } from "@/components/alert";
import { EmptyState, ErrorAlert, PageHeader, PageSkeleton, StatTile, StatusBadge, TrendChart } from "@/components/astra";
import { DeviceList, MeasurementTable, type Device } from "@/components/tables";
import { ScheduleDayList } from "@/components/schedule/schedule-day-list";
import { SimulationLab } from "@/components/dashboard/simulation-lab";
import { LiveTelemetry } from "@/components/dashboard/live-telemetry";
import { BodyCompositionBrief } from "@/components/body/body-composition";
import { CognitiveLoadPanel } from "@/components/cognitive-load-panel";
import { Alert as UiAlert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Trend = { unit: string; points: { value: number; measured_at: string }[]; baseline: { sufficient: boolean; median?: number; robust_sd?: number; n: number } };
type Dash = {
  view: "HEALTH" | "OPERATIONAL"; crewMemberId?: string; now: string; missionDay: number; mission: string; sync: SyncState; devices: Device[];
  alerts: Alert[]; tasks?: Task[]; recent?: Measurement[]; trends?: Record<string, Trend>; missingData?: Record<string, string[]>;
  reminders?: { id: string; kind: string; title: string; due_at: string; priority: string }[];
  radiation?: RadiationBrief;
  compliance: { by_category: { category: string; status: string; n: number }[] };
};

export function View() {
  const { crew, user } = useSession();
  const { data, error } = useData<Dash>(user.role === "MISSION_OPERATOR" ? "/dashboard" : `/dashboard?crew_member_id=${crew}`);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  return (
    <>
      <PageHeader
        title={data.view === "HEALTH" ? (user.crewMemberId === data.crewMemberId ? `Good ${greeting(data.now)}, ${user.name.split(" ").at(-1)}` : `Crew member ${crew}`) : "Operations overview"}
        description="Values are compared with your own baseline.">
        <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 font-mono text-xs">
          <span className="text-lg font-semibold text-primary">MD {data.missionDay}</span>
          <span className="text-muted-foreground">{data.mission}<br />{fmtDate(data.now)}</span>
        </div>
      </PageHeader>
      {data.view === "HEALTH" ? <Health d={data} /> : <Ops d={data} />}
    </>
  );
}

const greeting = (iso: string) => { const h = new Date(iso).getUTCHours(); return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; };

function Health({ d }: { d: Dash }) {
  const { refresh } = useSession();
  const byTime = (a: Task, b: Task) => a.due_at.localeCompare(b.due_at);
  const today = d.tasks?.filter((t) => t.due_at.slice(0, 10) === d.now.slice(0, 10)).sort(byTime) ?? [];
  const carried = d.tasks?.filter((t) => t.due_at.slice(0, 10) !== d.now.slice(0, 10)).sort(byTime) ?? [];
  const done = today.filter((t) => t.status === "COMPLETED").length;
  const medicalOpen = d.alerts.filter((a) => a.category === "MEDICAL").length;
  const online = d.devices.filter((x) => x.status === "ONLINE").length;
  const simulated = d.devices.filter((x) => x.integration === "SIMULATED").length;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Today's plan" value={`${done}/${today.length}`} icon={CalendarCheck} tone={done === today.length ? "ok" : "info"}>
          <Progress value={today.length ? (done / today.length) * 100 : 0} className="h-1.5" aria-label="Tasks completed today" />
        </StatTile>
        <StatTile label="Open alerts" value={d.alerts.length} icon={BellRing} tone={medicalOpen ? "warn" : "ok"}
          hint={`${medicalOpen} medical · ${d.alerts.length - medicalOpen} operational`} />
        <StatTile label="Sensors online" value={`${online}/${simulated}`} icon={Cpu} tone={online === simulated ? "ok" : "danger"} hint="connected adapters" />
        <StatTile label="Ground sync" value={d.sync.pending} unit="queued" icon={CloudUpload} tone={d.sync.link === "AOS" ? "ok" : "warn"}
          hint={<>link <StatusBadge value={d.sync.link} /> · ground holds {d.sync.ground_received}</>} />
      </div>

      {!!d.reminders?.length && (
        <UiAlert className="border-warning/30 bg-warning/5">
          <BellRing className="text-warning-strong!" />
          <AlertTitle>Reminders</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 flex w-full flex-col gap-1">
              {d.reminders.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-foreground">
                  <StatusBadge value={r.kind} />
                  <span className="flex-1 text-sm">{r.title} — due {fmtTime(r.due_at)}</span>
                  <Button size="icon-xs" variant="ghost" aria-label={`Dismiss reminder for ${r.title}`}
                    onClick={() => api(`/reminders/${r.id}/ack`, { method: "POST" }).then(refresh).catch((e) => toast.error(e.message))}><X /></Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </UiAlert>
      )}

      <SimulationLab />
      <LiveTelemetry key={d.crewMemberId} crew={d.crewMemberId!} initialPersonal={d.radiation?.personal.series ?? []}
        initialArea={d.radiation?.area.series ?? []} initialSleep={d.trends?.sleep_hours?.points ?? []} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Today&apos;s health plan</CardTitle>
            <CardDescription>Generated from approved protocol versions. Completion requires evidence that meets each task&apos;s criteria.</CardDescription>
            <CardAction><Button size="sm" variant="outline" asChild><Link href="/schedule">Full schedule</Link></Button></CardAction>
          </CardHeader>
          <CardContent>
            <ScheduleDayList tasks={today} ops={false} />
            {!!carried.length && (
              <>
                <p className="mt-5 mb-2 text-xs font-medium uppercase tracking-wider text-warning-strong">Carried over from previous days</p>
                <ScheduleDayList tasks={carried} ops={false} />
              </>
            )}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Active alerts</CardTitle>
              <CardAction><Button size="sm" variant="ghost" asChild><Link href="/alerts">View all</Link></Button></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {d.alerts.length ? d.alerts.slice(0, 4).map((a) => <AlertCard key={a.id} alert={a} compact />) : <EmptyState icon={BellRing}>No open alerts</EmptyState>}
            </CardContent>
          </Card>
          {d.crewMemberId && <BodyCompositionBrief crew={d.crewMemberId} />}
          {d.crewMemberId && <CognitiveLoadPanel crew={d.crewMemberId} compact />}
          <Card>
            <CardHeader><CardTitle>Sensors</CardTitle></CardHeader>
            <CardContent><DeviceList devices={d.devices.filter((x) => x.integration === "SIMULATED")} /></CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {d.trends && Object.entries(d.trends).map(([metric, t]) => {
          const Icon = metric === "sleep_hours" ? Moon : metric === "body_mass" ? Scale : HeartPulse;
          const latest = t.points.at(-1)?.value;
          return (
            <Card key={metric}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Icon className="size-4 text-primary" />{metricLabel(metric)}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {t.baseline.sufficient ? `baseline ${t.baseline.median} ± ${t.baseline.robust_sd} ${t.unit} · n=${t.baseline.n}` : `baseline insufficient · n=${t.baseline.n}`}
                </CardDescription>
                <CardAction className="font-mono text-xl font-semibold tabular-nums">{latest ?? "—"}<span className="ml-1 text-xs font-normal text-muted-foreground">{t.unit}</span></CardAction>
              </CardHeader>
              <CardContent>
                <TrendChart points={t.points} baseline={t.baseline} unit={t.unit} label={metric} />
                {!!d.missingData?.[metric]?.length && <p className="mt-2 text-xs text-warning-strong">Missing days: {d.missingData[metric].join(", ")}</p>}
              </CardContent>
            </Card>
          );
        })}
        {d.radiation && <RadiationCard r={d.radiation} />}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent measurements</CardTitle>
          <CardAction><Button size="sm" variant="outline" asChild><Link href="/measurements">Record / history</Link></Button></CardAction>
        </CardHeader>
        <CardContent><MeasurementTable rows={d.recent ?? []} /></CardContent>
      </Card>
    </>
  );
}

function Ops({ d }: { d: Dash }) {
  const rows = d.compliance.by_category;
  const categories = [...new Set(rows.map((r) => r.category))];
  const n = (c: string, s: string) => rows.find((r) => r.category === c && r.status === s)?.n ?? 0;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Operational alerts" value={d.alerts.length} icon={BellRing} tone={d.alerts.length ? "warn" : "ok"} />
        <StatTile label="Devices online" value={`${d.devices.filter((x) => x.status === "ONLINE").length}/${d.devices.filter((x) => x.integration === "SIMULATED").length}`} icon={Cpu} />
        <StatTile label="Ground sync" value={d.sync.pending} unit="queued" icon={CloudUpload} tone={d.sync.link === "AOS" ? "ok" : "warn"} hint={`link ${d.sync.link}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Operational alerts</CardTitle><CardDescription>Medical alerts are not visible to mission operations.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">{d.alerts.length ? d.alerts.map((a) => <AlertCard key={a.id} alert={a} />) : <EmptyState>No open operational alerts</EmptyState>}</CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Task compliance · 7 days</CardTitle><CardDescription>Counts only. No clinical values.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-right">Completed</TableHead><TableHead className="text-right">Pending</TableHead><TableHead className="text-right">Overdue</TableHead></TableRow></TableHeader>
                <TableBody>
                  {categories.map((c) => (
                    <TableRow key={c}>
                      <TableCell className="font-mono text-xs">{c}</TableCell>
                      <TableCell className="text-right font-mono text-success">{n(c, "COMPLETED")}</TableCell>
                      <TableCell className="text-right font-mono">{n(c, "PENDING")}</TableCell>
                      <TableCell className="text-right font-mono text-warning-strong">{n(c, "OVERDUE")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card><CardHeader><CardTitle>Devices</CardTitle></CardHeader><CardContent><DeviceList devices={d.devices} /></CardContent></Card>
        </div>
      </div>
    </>
  );
}

function RadiationCard({ r }: { r: RadiationBrief }) {
  // An onboard node running an older API returns no stored series; degrade instead of crashing.
  const p = r.personal.latest ?? null;
  const series = r.personal.series ?? [];
  const tiles: [string, number | null | undefined, string][] = [
    ["Personal rate", p?.dose_rate_uGy_h, "µGy/h"],
    ["Area rate", r.area?.latest?.dose_rate_uGy_h, "µGy/h"],
    ["Mission cumulative", p?.cumulative_uGy, "µGy"],
    [`Last ${r.window_days ?? 7} days`, r.personal.window_dose_uGy, "µGy"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Radiation className="size-4 text-warning-strong" />Radiation</CardTitle>
        <CardDescription>
          {p ? <>Last personal reading {fmtDate(p.measured_at)} · {p.source === "MANUAL" ? "manual entry" : "dosimeter"}</> : "No personal readings yet"}
        </CardDescription>
        <CardAction><Button size="sm" variant="outline" asChild><Link href="/measurements?tab=radiation">Log reading</Link></Button></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2">
          {tiles.map(([k, v, u]) => (
            <div key={k} className="rounded-md bg-muted/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
              <dd className="font-mono text-lg tabular-nums">{v == null ? "—" : v.toLocaleString()}<span className="ml-1 text-xs text-muted-foreground">{u}</span></dd>
            </div>
          ))}
        </dl>
        {series.length ? <TrendChart points={series} baseline={{ sufficient: false }} unit="µGy/h" label="dose rate" className="h-28" /> : <EmptyState icon={Radiation}>No stored dosimetry from the onboard node</EmptyState>}
      </CardContent>
    </Card>
  );
}
