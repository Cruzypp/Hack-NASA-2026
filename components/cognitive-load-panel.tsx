"use client";

import Link from "next/link";
import { BellRing, BrainCircuit } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { fmtDate, isMedical } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useCognitiveLoad, type FlightSignal } from "@/lib/cognitive-load";
import { EmptyState, ErrorAlert, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const config = { load: { label: "Cognitive load", color: "var(--chart-2)" } } satisfies ChartConfig;

/** Last LOFT cognitive-load session (live while running), with history unless `compact`. */
export function CognitiveLoadPanel({ crew, compact }: { crew: string; compact?: boolean }) {
  const c = useCognitiveLoad(crew);
  const { user } = useSession();
  if (c.error) return <ErrorAlert error={c.error} />;
  const latest = c.overview?.latest;
  const s = latest?.summary;
  const rows = c.live.length
    ? c.live.map((x) => ({ t: x.t.toFixed(1), load: x.cognitive_load }))
    : (latest?.trace ?? []).map((x, i) => ({ t: (i / (s?.source.hz ?? 8)).toFixed(1), load: x.cognitive_load }));
  const z = (c.current?.z ?? s?.peak_z ?? null) as Record<FlightSignal, number> | null;
  const threshold = c.overview?.rule.threshold_z ?? 3;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BrainCircuit className="size-4 text-primary" />Cognitive load
          {c.running ? <StatusBadge value="RUNNING" dot className="animate-pulse" /> : latest && <StatusBadge value={latest.status} />}
        </CardTitle>
        <CardDescription>{c.overview?.source_note ?? "LOFT playback"}</CardDescription>
        {s?.alert_id && !isMedical(user.role) && <CardAction><Button size="sm" variant="outline" asChild><Link href="/alerts"><BellRing />Alert</Link></Button></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!rows.length ? <EmptyState icon={BrainCircuit}>No cognitive-load sessions yet. Start the LOFT playback in the simulation lab.</EmptyState> : (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Now / peak", c.current ? `${c.current.cognitive_load.toFixed(0)}%` : s?.peak_load != null ? `${s.peak_load.toFixed(0)}%` : "—"],
                ["Peak phase", c.current?.phase ?? s?.peak_phase ?? "—"],
                ["Alert time", s ? `${s.alert_s} s` : "—"],
                ["Session", latest ? fmtDate(latest.started_at) : "—"]].map(([k, v]) => (
                <div key={k} className="rounded-md bg-muted/50 px-3 py-2">
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
                  <dd className="font-mono text-sm tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <ChartContainer config={config} className={cn("aspect-auto w-full", compact ? "h-28" : "h-48")}>
              <LineChart data={rows} margin={{ left: -18, right: 8, top: 8 }} accessibilityLayer>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={32} tickFormatter={(v) => `${v}s`} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}%`} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={(v) => `${v}%`} />} />
                <Line dataKey="load" type="monotone" stroke="var(--color-load)" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartContainer>
            {z && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(z).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <div className="flex justify-between"><span className="font-mono">{k}</span><span className={cn("font-mono tabular-nums", v >= threshold && "text-warning-strong")}>z {v.toFixed(1)}</span></div>
                    <div className="mt-1 h-1.5 rounded bg-muted"><div className={cn("h-full rounded", v >= threshold ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, (v / (threshold * 2)) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
            {s && !compact && (
              <p className="text-xs text-muted-foreground">
                Mean by phase: {Object.entries(s.mean_by_phase).map(([p, v]) => `${p} ${v}%`).join(" · ")}. Rule {s.rule.id}@{s.rule.version}: {s.rule.provenance}
              </p>
            )}
          </>
        )}
        {!compact && !!c.overview?.sessions.length && (
          <Table>
            <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Peak</TableHead><TableHead>Peak phase</TableHead><TableHead className="text-right">Alert time</TableHead></TableRow></TableHeader>
            <TableBody>
              {c.overview.sessions.map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="font-mono text-xs">{fmtDate(x.started_at)}</TableCell>
                  <TableCell><StatusBadge value={x.status} /></TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{x.summary?.peak_load != null ? `${x.summary.peak_load.toFixed(0)}%` : "—"}</TableCell>
                  <TableCell className="text-xs">{x.summary?.peak_phase ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{x.summary ? `${x.summary.alert_s} s` : "—"}{x.summary?.alert_id && <StatusBadge value="ALERT" tone="warn" className="ml-2" />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
