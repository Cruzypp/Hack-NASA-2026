"use client";

import Link from "next/link";
import { BellRing, BookText, CalendarClock, ClipboardCheck, Dumbbell, Radiation, ScanSearch } from "lucide-react";
import { fmtDate, type LogEntry, type Measurement, type RadiationBrief, type ReviewReport } from "@/lib/api";
import { useData } from "@/lib/session";
import { humanize } from "@/lib/labels";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge, TaskIcon } from "@/components/astra";
import { BodyCompositionBrief } from "@/components/body/body-composition";
import { RunReview } from "@/components/crew/reviews";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type Vital = {
  metric: string; label: string; unit: string; status: string; latest: Measurement | null; z?: number;
  baseline?: { sufficient: boolean; median?: number; robust_sd?: number; n: number };
};
type Overview = {
  name: string | null; mission_day: number; vitals: Vital[];
  compliance: { category: string; done: number; total: number; rate: number | null }[];
  open_alerts: { id: string; category: string; type: string; title: string; created_at: string }[];
  follow_ups: { id: string; title: string; due_at: string; status: string }[];
  upcoming: { id: string; title: string; task_type: string; category: string; due_at: string; priority: string; status: string }[];
  last_session: { status: string; ended_at: string | null; summary: { valid_minutes: number; hr_mean: number | null } | null } | null;
  radiation: RadiationBrief; last_review: ReviewReport | null; recent_log: LogEntry[];
};

export function StatusPanel({ crew }: { crew: string }) {
  const { data, error } = useData<Overview>(`/crew/${crew}/overview`);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  const outside = data.vitals.filter((v) => v.status === "OUTSIDE_BASELINE").length;

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="font-semibold">{data.name ?? crew}</span>
          <span className="font-mono text-primary">MD {data.mission_day}</span>
          <span className={cn(outside ? "text-warning-strong" : "text-muted-foreground")}>{outside} vital sign(s) outside personal baseline</span>
          <span className={cn(data.open_alerts.length ? "text-warning-strong" : "text-muted-foreground")}>{data.open_alerts.length} open alert(s)</span>
          <span className="text-muted-foreground">{data.follow_ups.length} pending follow-up(s)</span>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.vitals.map((v) => <VitalTile key={v.metric} v={v} />)}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CalendarClock className="size-4 text-primary" />Next 24 hours</CardTitle>
            <CardAction><Button size="sm" variant="ghost" asChild><Link href="/schedule">Schedule</Link></Button></CardAction>
          </CardHeader>
          <CardContent>
            {data.upcoming.length ? (
              <ul className="flex flex-col divide-y">
                {data.upcoming.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                    <TaskIcon type={t.task_type} category={t.category} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{fmtDate(t.due_at)}</span>
                    {t.status === "OVERDUE" && <StatusBadge value="OVERDUE" />}
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={CalendarClock}>Nothing open in the next 24 h</EmptyState>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BellRing className="size-4 text-warning-strong" />Alerts & follow-ups</CardTitle>
            <CardAction><Button size="sm" variant="ghost" asChild><Link href="/alerts">Open</Link></Button></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {!data.open_alerts.length && !data.follow_ups.length && <EmptyState icon={BellRing}>Nothing open</EmptyState>}
            {data.open_alerts.map((a) => (
              <div key={a.id} className="flex items-start gap-2">
                <StatusBadge value={a.category} />
                <span className="flex-1">{a.title}</span>
              </div>
            ))}
            {data.follow_ups.map((t) => (
              <div key={t.id} className="flex items-start gap-2 text-muted-foreground">
                <ClipboardCheck className="mt-0.5 size-4 shrink-0" />
                <span className="flex-1">{t.title} · due {fmtDate(t.due_at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Plan compliance · 7 days</CardTitle><CardDescription>Completed vs scheduled, cancelled tasks excluded.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.compliance.length ? data.compliance.map((c) => (
              <div key={c.category} className="flex flex-col gap-1">
                <div className="flex justify-between text-xs"><span>{humanize(c.category)}</span><span className="font-mono">{c.done}/{c.total}</span></div>
                <Progress value={(c.rate ?? 0) * 100} className="h-1.5" aria-label={`${humanize(c.category)} compliance`} />
              </div>
            )) : <EmptyState>No tasks in the last 7 days</EmptyState>}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ScanSearch className="size-4 text-primary" />Latest review</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {data.last_review ? (
              <>
                <div className="flex items-center gap-2">
                  <StatusBadge value={data.last_review.result.status} dot />
                  <span className="text-muted-foreground">{data.last_review.result.label} · {data.last_review.result.window_days} d · {fmtDate(data.last_review.created_at)}</span>
                </div>
                <p>{data.last_review.result.deviations.length} value(s) outside baseline{data.last_review.result.shift?.flagged ? ", sustained shift" : ""}.</p>
              </>
            ) : <p className="text-muted-foreground">No review yet.</p>}
            <RunReview crew={crew} compact />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Radiation className="size-4 text-warning-strong" />Radiation · 7 days</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Stat k="Personal rate" v={data.radiation.personal.latest?.dose_rate_uGy_h} u="µGy/h" />
              <Stat k="7-day dose" v={data.radiation.personal.window_dose_uGy} u="µGy" />
              <Stat k="Cumulative" v={data.radiation.personal.latest?.cumulative_uGy} u="µGy" />
              <Stat k="Area rate" v={data.radiation.area.latest?.dose_rate_uGy_h} u="µGy/h" />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Dumbbell className="size-4 text-primary" />Last exercise session</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {data.last_session ? (
              <div className="flex flex-col gap-1">
                <StatusBadge value={data.last_session.status} dot />
                <p>{data.last_session.summary?.valid_minutes ?? "—"} valid min · mean HR {data.last_session.summary?.hr_mean ?? "—"} bpm</p>
                <p className="text-xs text-muted-foreground">{fmtDate(data.last_session.ended_at)}</p>
              </div>
            ) : <p className="text-muted-foreground">No sessions recorded.</p>}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <BodyCompositionBrief crew={crew} />
        <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookText className="size-4 text-primary" />Recent logbook entries</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent_log.length ? (
            <ul className="flex flex-col divide-y text-sm">
              {data.recent_log.map((e) => (
                <li key={e.id} className="flex gap-3 py-2">
                  <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{fmtDate(e.created_at)}</span>
                  <StatusBadge value={e.category} tone="info" />
                  <span className="min-w-0 flex-1">{e.body}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={BookText}>No entries yet</EmptyState>}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

function VitalTile({ v }: { v: Vital }) {
  const m = v.latest;
  return (
    <Card size="sm" className={cn(v.status === "OUTSIDE_BASELINE" && "ring-warning/50")}>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{v.label}</span>
          <StatusBadge value={v.status} />
        </div>
        <p className="font-mono text-2xl font-semibold tabular-nums">
          {m ? m.value : "—"}<span className="ml-1 text-sm font-normal text-muted-foreground">{v.unit}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {v.baseline?.sufficient ? <>Baseline {v.baseline.median} ± {v.baseline.robust_sd} · z {v.z! > 0 ? `+${v.z}` : v.z}</> : v.baseline ? `Baseline needs more data (n=${v.baseline.n})` : "No measurements"}
        </p>
        {m && <p className="text-[11px] text-muted-foreground">{fmtDate(m.measured_at)} · {humanize(m.source)}</p>}
      </CardContent>
    </Card>
  );
}

function Stat({ k, v, u }: { k: string; v: number | null | undefined; u: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
      <dd className="font-mono tabular-nums">{v == null ? "—" : v.toLocaleString()} <span className="text-xs text-muted-foreground">{u}</span></dd>
    </div>
  );
}
