"use client";

// ASTRA domain building blocks on top of shadcn/ui.
import { Activity, ClipboardCheck, Dumbbell, HeartPulse, Inbox, Moon, Radiation, Stethoscope, TriangleAlert, type LucideIcon, ScanSearch, Smile } from "lucide-react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-success/12 text-success border-success/25",
  warn: "bg-warning/12 text-warning-strong border-warning/30",
  danger: "bg-destructive/12 text-destructive border-destructive/30",
  info: "bg-secondary text-secondary-foreground border-border",
  neutral: "bg-transparent text-muted-foreground border-border",
};

const STATUS_TONE: Record<string, Tone> = {
  COMPLETED: "ok", RESOLVED: "ok", ONLINE: "ok", AOS: "ok", GOOD: "ok", WITHIN_BASELINE: "ok", RAN: "ok",
  PENDING: "info", ACKNOWLEDGED: "info", RUNNING: "info", ROUTINE: "neutral",
  OVERDUE: "warn", HIGH: "warn", OPEN: "warn", LOS: "warn", DEGRADED: "warn", REVIEW: "warn", DEVIATION: "warn",
  MEDICAL: "warn", SIMULATED: "warn", DUE: "info", INSUFFICIENT_BASELINE: "neutral",
  CRITICAL: "danger", FAULT: "danger", FAULTED: "danger", INVALID: "danger", ESCALATION: "danger",
  OPERATIONAL: "info", OUTSIDE_BASELINE: "warn", FINDINGS: "warn", NO_BASELINE: "neutral", NO_DATA: "neutral",
  INSUFFICIENT_DATA: "neutral", CLINICAL_DECISION: "info", SHARED: "ok", NOT_INTEGRATED: "neutral", NOT_CONNECTED: "neutral",
};

export function StatusBadge({ value, tone, dot, className }: { value: string; tone?: Tone; dot?: boolean; className?: string }) {
  const t = tone ?? STATUS_TONE[value] ?? "neutral";
  return (
    <Badge variant="outline" className={cn("rounded-md font-mono text-[10px] uppercase tracking-wider", TONE_CLASS[t], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function StatTile({ label, value, unit, hint, icon: Icon, tone = "info", children }: {
  label: string; value: ReactNode; unit?: string; hint?: ReactNode; icon: LucideIcon; tone?: Tone; children?: ReactNode;
}) {
  const accent = { ok: "text-success", warn: "text-warning-strong", danger: "text-destructive", info: "text-primary", neutral: "text-muted-foreground" }[tone];
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
          <Icon className={cn("size-4", accent)} aria-hidden />
        </div>
        <p className="font-mono text-2xl font-semibold tabular-nums">
          {value}
          {unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
        </p>
        {children}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ children, icon: Icon = Inbox }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
      <Icon className="size-5 opacity-60" aria-hidden />
      {children}
    </div>
  );
}

export function ErrorAlert({ error, title = "Request failed" }: { error: string | null; title?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      <Skeleton className="h-72" />
    </div>
  );
}

/** Icon for a task, by type (sleep logs get their own). */
export function TaskIcon({ type, category, className }: { type: string; category?: string; className?: string }) {
  if (category === "SLEEP") return <Moon className={className} aria-hidden />;
  switch (type) {
    case "EXERCISE": return <Dumbbell className={className} aria-hidden />;
    case "MEASUREMENT": return <HeartPulse className={className} aria-hidden />;
    case "DEVICE_CHECK":
    case "RADIATION_READING": return <Radiation className={className} aria-hidden />;
    case "ANALYSIS": return <ScanSearch className={className} aria-hidden />;
    case "RECREATION": return <Smile className={className} aria-hidden />;
    case "EVALUATION": return <Stethoscope className={className} aria-hidden />;
    case "VERIFICATION": return <ClipboardCheck className={className} aria-hidden />;
    default: return <Activity className={className} aria-hidden />;
  }
}

// ---------------------------------------------------------------- charts

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

/** Longitudinal trend against the person's own baseline band (median ± 2 robust SD). */
export function TrendChart({ points, baseline, unit, label, className }: {
  points: { value: number; measured_at: string }[];
  baseline: { sufficient: boolean; median?: number; robust_sd?: number };
  unit: string; label: string; className?: string;
}) {
  if (points.length < 2) return <EmptyState>Not enough data for a trend</EmptyState>;
  const config = { value: { label, color: "var(--chart-1)" } } satisfies ChartConfig;
  const data = points.map((p) => ({ t: day(p.measured_at), value: p.value }));
  const band = baseline.sufficient ? [baseline.median! - 2 * baseline.robust_sd!, baseline.median! + 2 * baseline.robust_sd!] : null;
  const values = points.map((p) => p.value).concat(band ?? []);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.15 || 1;
  const id = label.replace(/\W/g, "");
  return (
    <ChartContainer config={config} className={cn("aspect-auto h-40 w-full", className)}>
      <AreaChart data={data} margin={{ left: -18, right: 8, top: 8 }} accessibilityLayer>
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis tickLine={false} axisLine={false} width={44} domain={[Math.min(...values) - pad, Math.max(...values) + pad]} tickFormatter={(v: number) => v.toFixed(v < 20 ? 1 : 0)} />
        {band && <ReferenceArea y1={band[0]} y2={band[1]} fill="var(--chart-1)" fillOpacity={0.07} stroke="none" />}
        {band && <ReferenceLine y={baseline.median} stroke="var(--chart-1)" strokeDasharray="4 4" strokeOpacity={0.5} />}
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" formatter={(v) => `${v} ${unit}`} />} />
        <Area dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} fill={`url(#fill-${id})`}
          dot={(p: { cx?: number; cy?: number; index?: number }) => p.index === data.length - 1
            ? <circle key="last" cx={p.cx} cy={p.cy} r={4} fill="var(--chart-2)" stroke="var(--background)" strokeWidth={2} />
            : <g key={p.index} />} />
      </AreaChart>
    </ChartContainer>
  );
}

/** Live heart-rate stream; artefact samples (null) render as gaps. */
export function LiveHrChart({ samples }: { samples: { offset_s: number; value: number | null }[] }) {
  const config = { value: { label: "Heart rate", color: "var(--chart-1)" } } satisfies ChartConfig;
  const data = samples.map((s) => ({ m: +(s.offset_s / 60).toFixed(1), value: s.value }));
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <LineChart data={data} margin={{ left: -18, right: 8, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="m" type="number" domain={[0, 30]} ticks={[0, 5, 10, 15, 20, 25, 30]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}′`} />
        <YAxis domain={[50, 170]} tickLine={false} axisLine={false} width={44} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={(v) => (v == null ? "artefact" : `${v} bpm`)} />} />
        <Line dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
