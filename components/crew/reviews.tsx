"use client";

import Link from "next/link";
import { useState } from "react";
import { ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, type ReviewReport } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { metricLabel } from "@/lib/labels";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const REVIEW_METRICS = ["resting_hr", "sleep_hours", "systolic_bp", "diastolic_bp", "body_temp", "body_mass"];

/** On-demand deviation review, same rule as the scheduled one. */
export function RunReview({ crew, compact }: { crew: string; compact?: boolean }) {
  const { refresh } = useSession();
  const [metric, setMetric] = useState("resting_hr");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await api<ReviewReport>(`/crew/${crew}/reports`, { body: { metric, window_days: Number(days) } });
      const s = r.result;
      (s.status === "FINDINGS" ? toast.warning : toast.success)(`${s.label}: ${s.status.toLowerCase().replaceAll("_", " ")}`,
        { description: `${s.n} values, ${s.deviations.length} outside baseline${s.alert_id ? " — alert and CMO review created" : ""}` });
      refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1.5">
        {!compact && <Label>Metric</Label>}
        <Select value={metric} onValueChange={setMetric}>
          <SelectTrigger size="sm" className="w-44" aria-label="Metric to review"><SelectValue /></SelectTrigger>
          <SelectContent>{REVIEW_METRICS.map((m) => <SelectItem key={m} value={m}>{metricLabel(m)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        {!compact && <Label htmlFor="rv-days">Days</Label>}
        <Input id="rv-days" type="number" min={1} max={31} value={days} onChange={(e) => setDays(e.target.value)} className="h-7 w-16 font-mono" aria-label="Window in days" />
      </div>
      <Button size="sm" variant="outline" onClick={run} disabled={busy}><ScanSearch />{busy ? "Reviewing…" : "Run review"}</Button>
    </div>
  );
}

export function Reviews({ crew }: { crew: string }) {
  const { data, error } = useData<ReviewReport[]>(`/crew/${crew}/reports`);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Run a deviation review</CardTitle>
          <CardDescription>Searches the window for values outside the personal baseline (28 days before the window) and for a sustained shift. Findings create an alert and a CMO review; the protocol is never changed automatically.</CardDescription>
        </CardHeader>
        <CardContent><RunReview crew={crew} /></CardContent>
      </Card>
      {!data.length ? <Card><CardContent><EmptyState icon={ScanSearch}>No reviews yet. Schedule a weekly one from the care plan, or run one now.</EmptyState></CardContent></Card>
        : data.map((r) => <ReportCard key={r.id} r={r} />)}
    </div>
  );
}

function ReportCard({ r }: { r: ReviewReport }) {
  const s = r.result;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScanSearch className="size-4 text-primary" />{s.label} · {s.window_days}-day review</CardTitle>
        <CardDescription className="font-mono text-xs">{fmtDate(r.window_from)} → {fmtDate(r.window_to)} · {r.task_id ? "scheduled" : "on demand"} · {s.rule.id}@{s.rule.version}</CardDescription>
        <CardAction><StatusBadge value={s.status} dot /></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[["Values", s.n], ["Window mean", s.mean != null ? `${s.mean} ${s.unit}` : "—"],
            ["Baseline", s.baseline.sufficient ? `${s.baseline.median} ± ${s.baseline.robust_sd}` : `n=${s.baseline.n}`],
            ["Shift", s.shift ? `${s.shift.sd > 0 ? "+" : ""}${s.shift.sd} SD` : "—"]].map(([k, v]) => (
            <div key={k} className="rounded-md bg-muted/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
              <dd className="font-mono tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {!!s.deviations.length && (
          <ul className="flex flex-col gap-1">
            {s.deviations.map((d) => (
              <li key={d.id} className="flex gap-3 text-xs">
                <span className="font-mono text-muted-foreground">{fmtDate(d.measured_at)}</span>
                <span className="font-mono">{d.value} {s.unit}</span>
                <span className="font-mono text-warning-strong">z {d.z > 0 ? "+" : ""}{d.z}</span>
              </li>
            ))}
          </ul>
        )}
        {!!s.missing_days.length && <p className="text-xs text-warning-strong">Days without data: {s.missing_days.join(", ")}</p>}
        {s.alert_id && <p className="text-xs"><Link href="/alerts" className="text-primary underline-offset-4 hover:underline">Alert and CMO review created →</Link></p>}
      </CardContent>
    </Card>
  );
}
