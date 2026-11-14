"use client";

import { useState } from "react";
import { BellRing, CircleCheck, Download, Dumbbell, HeartPulse, Radiation, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, ErrorAlert, PageHeader, PageSkeleton, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { humanize, metricLabel } from "@/lib/labels";

type Item = { at: string; kind: string; data: Record<string, unknown> };

const KIND: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  measurement: { icon: HeartPulse, label: "Measurements", color: "text-primary border-primary/30 bg-primary/10" },
  session: { icon: Dumbbell, label: "Exercise", color: "text-chart-3 border-chart-3/30 bg-chart-3/10" },
  alert: { icon: BellRing, label: "Alerts", color: "text-warning-strong border-warning/30 bg-warning/10" },
  task: { icon: CircleCheck, label: "Tasks", color: "text-success border-success/30 bg-success/10" },
  radiation: { icon: Radiation, label: "Radiation", color: "text-warning-strong border-warning/30 bg-warning/10" },
};

function describe(i: Item): { title: string; meta?: string; badge?: string } {
  const d = i.data as Record<string, never>;
  switch (i.kind) {
    case "measurement": return { title: `${metricLabel(d.metric)} · ${d.value} ${d.unit}`, meta: `${humanize(d.source)}${d.correction_reason ? ` · corrected: ${d.correction_reason}` : ""}`, badge: d.superseded ? "SUPERSEDED" : d.quality };
    case "session": {
      const s = d.summary as { valid_minutes?: number; hr_mean?: number } | null;
      return { title: "Exercise session", meta: `${s?.valid_minutes ?? "—"} valid min · mean HR ${s?.hr_mean ?? "—"}`, badge: d.status };
    }
    case "alert": return { title: d.title, meta: `${humanize(d.category)} · ${humanize(d.type)}`, badge: d.status };
    case "task": return { title: d.title, meta: `${humanize(d.schedule_type)} · evidence ${(d.evidenceIds as string[] | undefined)?.length ?? 0}`, badge: "COMPLETED" };
    case "radiation": return { title: `Dosimeter · ${d.dose_rate_uGy_h} µGy/h`, meta: `cumulative ${d.cumulative_uGy} µGy${d.eva_id ? ` · ${d.eva_id}` : ""}` };
    default: return { title: i.kind };
  }
}

export function View() {
  const { crew } = useSession();
  const { data, error } = useData<Item[]>(`/records/${crew}/timeline`);
  const [filter, setFilter] = useState("all");

  async function exportJson() {
    try {
      const body = await api<unknown>(`/records/${crew}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `astra-${crew}-${new Date().toISOString().slice(0, 10)}.json` }).click();
      URL.revokeObjectURL(url);
      toast.success("Record exported", { description: "Export logged in the audit trail." });
    } catch (e) { toast.error((e as Error).message); }
  }

  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  const items = data.filter((i) => filter === "all" || i.kind === filter);
  const groups = new Map<string, Item[]>();
  items.slice(0, 250).forEach((i) => groups.set(i.at.slice(0, 10), [...(groups.get(i.at.slice(0, 10)) ?? []), i]));

  return (
    <>
      <PageHeader title={`Health record · ${crew}`} description="Longitudinal timeline of measurements, sessions, alerts, completed tasks and dosimetry. Export is structured JSON with rule and model provenance.">
        <Button variant="outline" onClick={exportJson}><Download />Export JSON</Button>
      </PageHeader>
      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="all">All</TabsTrigger>
          {Object.entries(KIND).map(([k, v]) => <TabsTrigger key={k} value={k}><v.icon />{v.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <Card>
        <CardHeader><CardTitle>Timeline</CardTitle><CardDescription className="font-mono text-xs">{items.length} entries</CardDescription></CardHeader>
        <CardContent>
          {!items.length ? <EmptyState>No entries</EmptyState> : (
            <div className="flex flex-col gap-6">
              {[...groups].map(([day, list]) => (
                <section key={day}>
                  <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">{new Date(day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</h3>
                  <ol className="relative flex flex-col gap-1 border-l pl-5">
                    {list.map((i, n) => {
                      const k = KIND[i.kind];
                      const d = describe(i);
                      return (
                        <li key={n} className="relative flex items-start gap-3 rounded-md py-1.5 pr-2">
                          <span className={cn("absolute -left-[33px] flex size-6 items-center justify-center rounded-full border", k?.color)}>{k && <k.icon className="size-3" />}</span>
                          <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{fmtDate(i.at).split(", ").at(-1)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">{d.title}</span>
                            {d.meta && <span className="block text-xs text-muted-foreground">{d.meta}</span>}
                          </span>
                          {d.badge && <StatusBadge value={String(d.badge)} />}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
