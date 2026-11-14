"use client";

import Link from "next/link";
import { useState } from "react";
import { BellRing, FlaskConical, Info, Lightbulb, PersonStanding, ScanLine, UserRound } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { api, fmtDate, isMedical, type BodyAssessment, type BodyComposition, type BodyFinding } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const LEVEL_CLASS: Record<string, string> = {
  WITHIN_REFERENCE: "border-success/30 bg-success/8 text-success",
  WATCH: "border-primary/30 bg-primary/8 text-primary",
  REVIEW: "border-warning/40 bg-warning/10 text-warning-strong",
  ACTION: "border-destructive/40 bg-destructive/10 text-destructive",
};
const LEVEL_TONE = { WITHIN_REFERENCE: "ok", WATCH: "info", REVIEW: "warn", ACTION: "danger", REFERENCE: "info", NO_REFERENCE: "neutral" } as const;
const RANK: Record<string, number> = { WITHIN_REFERENCE: 0, WATCH: 1, REVIEW: 2, ACTION: 3 };

const signed = (n: number | undefined, d = 1) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(d)}`);
const label = (a: BodyAssessment) => `${a.phase === "INFLIGHT" ? `MD ${a.mission_day}` : a.phase === "PREFLIGHT" ? "Pre" : "Post"} · ${a.measured_at.slice(5, 10)}`;

export function LevelBadge({ value }: { value: string }) {
  return <StatusBadge value={value} tone={LEVEL_TONE[value as keyof typeof LEVEL_TONE] ?? "neutral"} dot />;
}

/** Full body-composition workspace: generator, segmental map, trends, findings and history. */
export function BodyCompositionPanel({ crew }: { crew: string }) {
  const { data, error } = useData<BodyComposition>(`/body-composition/${crew}`);
  const [selected, setSelected] = useState<string | null>(null);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  const a = data.assessments.find((x) => x.id === selected) ?? data.latest;

  return (
    <div className="flex flex-col gap-4">
      <Generator crew={crew} scenarios={data.scenarios} />
      {!a ? <EmptyState icon={ScanLine}>No body composition assessments yet</EmptyState> : (
        <>
          <Summary a={a} />
          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><PersonStanding className="size-4 text-primary" />Segmental lean mass</CardTitle>
                <CardDescription>Change vs preflight {a.method} reference. Lean mass ≠ pure muscle.</CardDescription>
              </CardHeader>
              <CardContent><SegmentMap a={a} names={data.segments} thresholds={data.rule.segment_pct} /></CardContent>
            </Card>
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Trend vs preflight reference</CardTitle>
                <CardDescription>BIA assessments only — methods are not compared directly. Dashed lines: review / action thresholds.</CardDescription>
              </CardHeader>
              <CardContent><Trend data={data} /></CardContent>
            </Card>
          </div>
          <Context a={a} />
          <Findings a={a} />
          <History data={data} selected={a.id} onSelect={setSelected} />
        </>
      )}
    </div>
  );
}

function Generator({ crew, scenarios }: { crew: string; scenarios: Record<string, string> }) {
  const { refresh } = useSession();
  const [scenario, setScenario] = useState("LEG_ATROPHY");
  const [phase, setPhase] = useState("INFLIGHT");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const a = await api<BodyAssessment>("/demo/body-composition", { body: { scenario, phase, crew_member_id: crew } });
      const s = a.evaluation.status;
      const msg = `Assessment recorded · ${s.replaceAll("_", " ").toLowerCase()}`;
      if (a.alert_id) toast.warning(msg, { description: "Medical alert and CMO review task created." });
      else toast.success(msg, { description: a.evaluation.summary });
      refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <Card className="border-primary/25 bg-primary/[0.03]" size="sm">
      <CardContent className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"><FlaskConical className="size-3.5 text-primary" />Simulate InBody-type scan · {crew}</span>
        <Select value={scenario} onValueChange={setScenario} disabled={busy}>
          <SelectTrigger className="w-64" aria-label="Scenario"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(scenarios).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            <SelectItem value="RANDOM">Random scenario</SelectItem>
          </SelectContent>
        </Select>
        <Select value={phase} onValueChange={setPhase} disabled={busy}>
          <SelectTrigger className="w-36" aria-label="Mission phase"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="INFLIGHT">In-flight</SelectItem><SelectItem value="POSTFLIGHT">Postflight</SelectItem></SelectContent>
        </Select>
        <Button onClick={run} disabled={busy}><ScanLine />{busy ? "Measuring…" : "Create assessment"}</Button>
        <span className="text-[11px] text-muted-foreground">Synthetic data, stored with source SIMULATED and evaluated by the same rules as a real scan.</span>
      </CardContent>
    </Card>
  );
}

function Summary({ a }: { a: BodyAssessment }) {
  const d = a.evaluation.deltas;
  const v = a.values;
  const tiles: [string, number, string, string | undefined, boolean?][] = [
    ["Body mass", v.body_mass_kg, "kg", d.body_mass_kg && `${signed(d.body_mass_kg.pct)}%`],
    ["Fat-free mass", v.lean_mass_kg, "kg", d.lean_mass_kg && `${signed(d.lean_mass_kg.pct)}%`],
    ["Skeletal muscle (est.)", v.skeletal_muscle_kg, "kg", d.skeletal_muscle_kg && `${signed(d.skeletal_muscle_kg.pct)}%`],
    ["Body fat", v.body_fat_pct, "%", d.fat_mass_kg && `fat mass ${signed(d.fat_mass_kg.pct)}%`],
    ["ECW / TBW", v.ecw_ratio, "", d.ecw_ratio && `${signed(d.ecw_ratio.diff, 3)} vs ref`, v.ecw_ratio > 0.39],
    ["Phase angle", v.phase_angle_deg, "°", d.phase_angle_deg && `${signed(d.phase_angle_deg.diff)}° vs ref`],
  ];
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {label(a)} · {a.method_info.label}
          <LevelBadge value={a.evaluation.status} /><StatusBadge value={a.quality} /><StatusBadge value={a.source} tone="neutral" />
        </CardTitle>
        <CardDescription>{fmtDate(a.measured_at)} · {a.evaluation.summary}</CardDescription>
        {a.alert_id && <CardAction><Button size="sm" variant="outline" asChild><Link href="/alerts"><BellRing />Alert</Link></Button></CardAction>}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([k, val, u, delta, warn]) => (
          <div key={k} className={cn("rounded-md bg-muted/50 px-3 py-2", warn && "ring-1 ring-warning/50")}>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</p>
            <p className="font-mono text-lg font-semibold tabular-nums">{val}<span className="ml-1 text-xs font-normal text-muted-foreground">{u}</span></p>
            <p className="font-mono text-[11px] text-muted-foreground">{delta ?? "reference"}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SegmentMap({ a, names, thresholds }: { a: BodyAssessment; names: Record<string, string>; thresholds: Record<string, number> }) {
  const seg = a.evaluation.segments;
  // Anatomical view: the subject's right side is on the viewer's left.
  const cell = (k: string, area: string) => {
    const s = seg[k];
    return (
      <div key={k} style={{ gridArea: area }} className={cn("flex flex-col justify-center rounded-lg border px-2 py-2 text-center", s ? LEVEL_CLASS[s.level] : "border-border bg-muted/40")}>
        <span className="text-[10px] uppercase tracking-wider opacity-80">{names[k]}</span>
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{a.segments[k].toFixed(2)} kg</span>
        <span className="font-mono text-xs tabular-nums">{s ? `${signed(s.pct)}%` : "—"}</span>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="mx-auto grid w-full max-w-xs gap-2" style={{ gridTemplateAreas: `". head ." "ra trunk la" "ra trunk la" "rl . ll" "rl . ll"`, gridTemplateColumns: "1fr 1.3fr 1fr" }}>
        <div style={{ gridArea: "head" }} className="mx-auto flex size-10 items-center justify-center rounded-full border bg-muted/40"><UserRound className="size-4 text-muted-foreground" /></div>
        {cell("right_arm", "ra")}{cell("trunk", "trunk")}{cell("left_arm", "la")}{cell("right_leg", "rl")}{cell("left_leg", "ll")}
      </div>
      {a.evaluation.leg_asymmetry_pct && (
        <p className="text-center font-mono text-xs text-muted-foreground">Leg asymmetry {a.evaluation.leg_asymmetry_pct.value}% · preflight {a.evaluation.leg_asymmetry_pct.reference}%</p>
      )}
      <p className="flex flex-wrap justify-center gap-1.5">
        {Object.entries(thresholds).map(([lvl, t]) => <span key={lvl} className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px]", LEVEL_CLASS[lvl])}>{lvl} ≥ −{t}%</span>)}
      </p>
    </div>
  );
}

const trendConfig = {
  lean: { label: "Fat-free mass", color: "var(--chart-1)" },
  smm: { label: "Skeletal muscle", color: "var(--chart-3)" },
  right_leg: { label: "Right leg", color: "var(--chart-2)" },
  left_leg: { label: "Left leg", color: "var(--chart-5)" },
} satisfies ChartConfig;

function Trend({ data }: { data: BodyComposition }) {
  const ref = data.reference;
  const bia = data.assessments.filter((a) => a.method === "BIA");
  if (!ref || bia.length < 2) return <EmptyState>Not enough BIA assessments for a trend</EmptyState>;
  const pct = (v: number, r: number) => +(((v - r) / r) * 100).toFixed(1);
  const rows = bia.map((a) => ({
    t: label(a), lean: pct(a.values.lean_mass_kg, ref.values.lean_mass_kg), smm: pct(a.values.skeletal_muscle_kg, ref.values.skeletal_muscle_kg),
    right_leg: pct(a.segments.right_leg, ref.segments.right_leg), left_leg: pct(a.segments.left_leg, ref.segments.left_leg),
  }));
  const min = Math.min(-9, ...rows.flatMap((r) => [r.lean, r.smm, r.right_leg, r.left_leg])) - 1;
  return (
    <ChartContainer config={trendConfig} className="aspect-auto h-64 w-full">
      <LineChart data={rows} margin={{ left: -12, right: 12, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={44} domain={[Math.floor(min), 4]} tickFormatter={(v: number) => `${v}%`} />
        <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.4} />
        <ReferenceLine y={-data.rule.segment_pct.REVIEW} stroke="var(--warning)" strokeDasharray="4 4" />
        <ReferenceLine y={-data.rule.segment_pct.ACTION} stroke="var(--destructive)" strokeDasharray="4 4" />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" formatter={(v, n) => `${trendConfig[n as keyof typeof trendConfig]?.label ?? n}: ${v}%`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {Object.keys(trendConfig).map((k) => <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={{ r: 3 }} />)}
      </LineChart>
    </ChartContainer>
  );
}

function Context({ a }: { a: BodyAssessment }) {
  const c = a.evaluation.context;
  if (!c) return null;
  const tiles: [string, string, boolean?][] = [
    ["Exercise adherence", c.exercise_adherence == null ? "—" : `${Math.round(c.exercise_adherence * 100)}% · ${c.exercise_done}/${c.exercise_scheduled}`, c.exercise_adherence != null && c.exercise_adherence < 0.8],
    ["Telemetry sessions", `${c.telemetry_sessions} · ${c.telemetry_minutes} min`],
    ["Mean sleep", c.sleep_mean_h == null ? "—" : `${c.sleep_mean_h} h · n=${c.sleep_n}`],
    ["Mean RPE", c.rpe_mean == null ? "—" : `${c.rpe_mean} Borg`],
  ];
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Context · {c.window_days} days before this scan</CardTitle>
        <CardDescription>From the exercise, sleep and effort records. Shown alongside findings — co-occurrence is not causation.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {tiles.map(([k, v, warn]) => (
            <div key={k} className={cn("rounded-md bg-muted/50 px-3 py-2", warn && "ring-1 ring-warning/50")}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</p>
              <p className="font-mono text-sm tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{c.nutrition}</p>
      </CardContent>
    </Card>
  );
}

function Findings({ a }: { a: BodyAssessment }) {
  const { user } = useSession();
  const f = [...a.evaluation.findings].sort((x, y) => RANK[y.level] - RANK[x.level]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Lightbulb className="size-4 text-warning-strong" />Findings for review</CardTitle>
        <CardDescription>Rule-based and explainable. Observations, not diagnoses — no exercise or nutrition change is made automatically.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {f.length ? f.map((x) => <FindingCard key={x.code} f={x} medical={isMedical(user.role)} />) : <EmptyState>No findings against the reference thresholds</EmptyState>}
        <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-foreground"><Info className="size-3.5" />Method limitations · {a.method}</p>
          <ul className="mt-1 list-disc pl-5">{a.evaluation.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          {!!Object.keys(a.method_info.uncertainty).length && (
            <p className="mt-1 font-mono">Uncertainty: lean ±{a.method_info.uncertainty.lean_mass_kg} kg · segment ±{a.method_info.uncertainty.segment_pct}% · fat ±{a.method_info.uncertainty.body_fat_pct} pts</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FindingCard({ f, medical }: { f: BodyFinding; medical: boolean }) {
  return (
    <div className={cn("rounded-lg border p-3", LEVEL_CLASS[f.level].replace(/text-\S+/, ""))}>
      <div className="flex flex-wrap items-center gap-2">
        <LevelBadge value={f.level} />
        <span className="text-sm font-medium">{f.title}</span>
        <StatusBadge value={f.follow_up} tone={f.follow_up === "OPEN" ? "warn" : "neutral"} className="ml-auto" />
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Observation</dt><dd className="font-mono">{f.observation}</dd>
        <dt className="text-muted-foreground">Evidence</dt><dd>{fmtDate(f.evidence.date)} · {f.evidence.reference}</dd>
        <dt className="text-muted-foreground">Interpretation</dt><dd>{f.interpretation}</dd>
        <dt className="text-muted-foreground">Limitation</dt><dd>{f.limitations}</dd>
        <dt className="text-muted-foreground">{medical ? "Proposed review" : "Next step"}</dt>
        <dd>{medical ? f.action : "Your medical team has been notified and will review this with you."}</dd>
        <dt className="text-muted-foreground">Responsible</dt><dd>{f.responsible}</dd>
      </dl>
    </div>
  );
}

function History({ data, selected, onSelect }: { data: BodyComposition; selected: string; onSelect: (id: string) => void }) {
  const rows = [...data.assessments].reverse();
  return (
    <Card>
      <CardHeader><CardTitle>Assessment history</CardTitle><CardDescription>Select a row to inspect it. Preflight assessments of the same method form the personal reference.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead><TableHead>Phase</TableHead><TableHead>Method</TableHead>
              <TableHead className="text-right">Mass</TableHead><TableHead className="text-right">FFM</TableHead><TableHead className="text-right">SMM</TableHead>
              <TableHead className="text-right">R / L leg</TableHead><TableHead>Status</TableHead><TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id} onClick={() => onSelect(a.id)} className={cn("cursor-pointer", a.id === selected && "bg-muted/60")} aria-selected={a.id === selected}>
                <TableCell className="font-mono text-xs">{fmtDate(a.measured_at)}</TableCell>
                <TableCell className="text-xs">{a.phase === "INFLIGHT" ? `In-flight · MD ${a.mission_day}` : a.phase === "PREFLIGHT" ? "Preflight" : "Postflight"}</TableCell>
                <TableCell className="font-mono text-xs">{a.method}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.values.body_mass_kg}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.values.lean_mass_kg}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.values.skeletal_muscle_kg}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.segments.right_leg.toFixed(2)} / {a.segments.left_leg.toFixed(2)}</TableCell>
                <TableCell><LevelBadge value={a.evaluation.status} /></TableCell>
                <TableCell><StatusBadge value={a.source} tone="neutral" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Compact summary for dashboards and the clinician status panel. */
export function BodyCompositionBrief({ crew, className }: { crew: string; className?: string }) {
  const { data } = useData<BodyComposition>(`/body-composition/${crew}`);
  const a = data?.latest;
  const legs = a?.evaluation.segments;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PersonStanding className="size-4 text-primary" />Body composition</CardTitle>
        <CardAction><Button size="sm" variant="ghost" asChild><Link href="/body">Open</Link></Button></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {!a ? <p className="text-muted-foreground">{data ? "No assessments yet." : "Loading…"}</p> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <LevelBadge value={a.evaluation.status} />
              <span className="text-xs text-muted-foreground">{label(a)} · {a.method}</span>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              {[["FFM", a.evaluation.deltas.lean_mass_kg?.pct], ["Muscle est.", a.evaluation.deltas.skeletal_muscle_kg?.pct],
                ["Right leg", legs?.right_leg?.pct], ["Left leg", legs?.left_leg?.pct]].map(([k, v]) => (
                <div key={k as string} className="rounded-md bg-muted/50 px-3 py-1.5">
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
                  <dd className="font-mono tabular-nums">{v == null ? "—" : `${signed(v as number)}%`}</dd>
                </div>
              ))}
            </dl>
            <p className="line-clamp-2 text-xs text-muted-foreground">{a.evaluation.summary}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
