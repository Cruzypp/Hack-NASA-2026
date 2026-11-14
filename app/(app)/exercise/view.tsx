"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Activity, CircleCheck, CircleX, Dumbbell, HeartPulse, Moon, Play, RotateCcw, Signal, Timer } from "lucide-react";
import { toast } from "sonner";
import { api, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, LiveHrChart, PageHeader, StatTile, StatusBadge, TrendChart } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SimulationLab } from "@/components/dashboard/simulation-lab";
import { ExerciseSessionList, type ExerciseSession } from "@/components/exercise/exercise-session-list";

type Sample = { offset_s: number; value: number | null; quality: string };
type Summary = { valid_minutes: number; valid_fraction: number; duration_minutes: number; hr_mean: number | null; hr_peak: number | null };
type Finished = { session: { id: string; status: string; summary: Summary }; completion?: { accepted: boolean; reasons: string[]; manual_allowed: boolean } };
type ExSummary = { compliance: { status: string; n: number }[]; sessions: number; hr_mean_history: { value: number; measured_at: string }[]; rpe: { value: number; measured_at: string }[];
  sleep: { unit: string; points: { value: number; measured_at: string }[]; baseline: { sufficient: boolean; median?: number; robust_sd?: number } }; note: string };

const UNSCHEDULED = "__none";
const EXERCISE_SCENARIOS = [
  ["STANDARD", "Standard · passes"],
  ["SHORT", "Short · fails minimum"],
  ["LOW_QUALITY", "Low quality · fails signal"],
  ["ANOMALOUS", "Anomalous HR"],
  ["PEAKS", "Pronounced HR peaks"],
  ["FAULT", "Sensor fault"],
] as const;

export function View() {
  return <Suspense><Exercise /></Suspense>;
}

function Exercise() {
  const params = useSearchParams();
  const { user, crew, subscribe, refresh } = useSession();
  const tasks = useData<Task[]>(`/tasks?crew_member_id=${crew}`);
  const summary = useData<ExSummary>(`/exercise/summary?crew_member_id=${crew}`);
  const sessions = useData<ExerciseSession[]>(`/sessions?crew_member_id=${crew}`);
  const devices = useData<{ id: string; status: string }[]>("/devices");
  const open = tasks.data?.filter((t) => t.task_type === "EXERCISE" && (t.status === "PENDING" || t.status === "OVERDUE")) ?? [];
  const [taskId, setTaskId] = useState<string>(params.get("task") ?? "");
  const [exerciseScenario, setExerciseScenario] = useState("STANDARD");
  const [fault, setFault] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [done, setDone] = useState<Finished | null>(null);
  const own = user.crewMemberId === crew;
  const sensor = devices.data?.find((d) => d.id === "bio-monitor-sim");
  const selected = taskId || open[0]?.id || UNSCHEDULED;

  useEffect(() => subscribe((e) => {
    if (e.type === "sample" && e.session_id === session) setSamples((s) => [...s, e as unknown as Sample]);
    if (e.type === "session_finished" && (e as unknown as Finished).session.id === session) {
      const f = e as unknown as Finished;
      setDone(f);
      refresh();
      if (f.completion?.accepted) toast.success("Session complete — task closed with telemetry evidence");
      else if (f.session.status === "FAULTED") toast.error("Sensor fault during session", { description: "Incident logged. Manual log available." });
    }
  }), [refresh, subscribe, session]);

  async function start() {
    setSamples([]); setDone(null);
    try {
      const s = await api<{ id: string }>("/sessions", { body: { task_id: selected === UNSCHEDULED ? null : selected, scenario: fault ? "FAULT" : exerciseScenario } });
      setSession(s.id);
      refresh();
    } catch (x) { toast.error((x as Error).message); }
  }

  const live = samples.at(-1);
  const running = !!session && !done;
  const elapsed = live ? live.offset_s / 60 : 0;
  const quality = samples.length ? samples.filter((s) => s.quality !== "INVALID").length / samples.length : 0;
  const completed = summary.data?.compliance.find((c) => c.status === "COMPLETED")?.n ?? 0;
  const total = summary.data?.compliance.reduce((a, c) => a + c.n, 0) ?? 0;

  return (
    <>
      <PageHeader title="Exercise & recovery" description="Records sessions, effort, sleep and recovery and compares them with the crew member's own history." />

      {own && (
        <Card className={cn(running && "ring-primary/40")}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Dumbbell className="size-4 text-primary" />Session</CardTitle>
            <CardDescription>Live heart-rate telemetry from the Bio-Monitor.</CardDescription>
            <CardAction>{running ? <StatusBadge value="RUNNING" dot className="animate-pulse" /> : done ? <StatusBadge value={done.session.status} dot /> : null}</CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid min-w-64 flex-1 gap-2">
                <Label>Scheduled task</Label>
                <Select value={selected} onValueChange={setTaskId} disabled={running}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {open.map((t) => <SelectItem key={t.id} value={t.id}>{t.title} · {t.due_at.slice(5, 16).replace("T", " ")}Z · {t.status.toLowerCase()}</SelectItem>)}
                    <SelectItem value={UNSCHEDULED}>Additional exercise session</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid min-w-56 flex-1 gap-2">
                <Label>Simulation case</Label>
                <Select value={exerciseScenario} onValueChange={setExerciseScenario} disabled={running || fault}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{EXERCISE_SCENARIOS.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox id="fault" checked={fault} onCheckedChange={(v) => setFault(v === true)} disabled={running} />
                <Label htmlFor="fault" className="text-muted-foreground">Simulate sensor fault</Label>
              </div>
              {sensor && sensor.status !== "ONLINE" ? (
                <Button variant="outline" onClick={() => api("/devices/bio-monitor-sim/reset", { method: "POST" }).then(() => { toast.success("Sensor reset"); refresh(); })}>
                  <RotateCcw />Reset sensor <StatusBadge value={sensor.status} />
                </Button>
              ) : (
                <Button size="lg" onClick={start} disabled={running}><Play />{running ? "Recording…" : "Start session"}</Button>
              )}
            </div>

            {session && (
              <div className="grid gap-4 lg:grid-cols-4">
                <div className="rounded-lg border bg-background/40 p-2 lg:col-span-3"><LiveHrChart samples={samples} /></div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-1" aria-live="polite">
                  <Metric icon={HeartPulse} label="Heart rate" value={live?.value ?? "—"} unit={live?.value == null && live ? "artefact" : "bpm"} accent={live?.quality === "INVALID" ? "text-destructive" : "text-primary"} />
                  <Metric icon={Signal} label="Signal" value={<StatusBadge value={live?.quality ?? "—"} />} />
                  <Metric icon={Timer} label="Elapsed" value={`${elapsed.toFixed(1)}′`}><Progress value={(elapsed / 30) * 100} className="mt-1 h-1" /></Metric>
                  <Metric icon={Activity} label="Valid signal" value={`${Math.round(quality * 100)}%`} unit={`${samples.length} samples`} />
                </div>
              </div>
            )}
            {done && <Result r={done} taskId={selected === UNSCHEDULED ? "" : selected} />}
          </CardContent>
        </Card>
      )}

      <SimulationLab />
      <ExerciseSessionList sessions={sessions.data ?? []} loading={!sessions.data} />

      <div className="grid gap-4 lg:grid-cols-3">
        <StatTile label="Exercise compliance" value={`${completed}/${total}`} icon={Dumbbell} tone={completed === total ? "ok" : "warn"} hint={`${summary.data?.sessions ?? 0} sessions with telemetry`}>
          <Progress value={total ? (completed / total) * 100 : 0} className="h-1.5" />
          <div className="flex flex-wrap gap-1.5">{summary.data?.compliance.map((c) => <StatusBadge key={c.status} value={`${c.status} ${c.n}`} tone={c.status === "COMPLETED" ? "ok" : c.status === "OVERDUE" ? "warn" : "info"} />)}</div>
        </StatTile>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Moon className="size-4 text-primary" />Sleep · 14 days</CardTitle>
            <CardDescription>Band shows personal baseline ± 2 robust SD.</CardDescription>
          </CardHeader>
          <CardContent>{summary.data ? <TrendChart points={summary.data.sleep.points} baseline={summary.data.sleep.baseline} unit="h" label="sleep" /> : <EmptyState>Loading…</EmptyState>}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HeartPulse className="size-4 text-primary" />Mean session heart rate</CardTitle>
            <CardDescription>{summary.data?.hr_mean_history.length ?? 0} completed telemetry sessions.</CardDescription>
          </CardHeader>
          <CardContent>{summary.data ? <TrendChart points={summary.data.hr_mean_history} baseline={{ sufficient: false }} unit="bpm" label="session hr" /> : <EmptyState>Loading…</EmptyState>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4 text-primary" />Perceived exertion</CardTitle>
            <CardDescription>Borg 6–20, last {summary.data?.rpe.length ?? 0} entries. {summary.data?.note}</CardDescription>
          </CardHeader>
          <CardContent>{summary.data ? <TrendChart points={[...summary.data.rpe].reverse()} baseline={{ sufficient: false }} unit="Borg" label="rpe" /> : <EmptyState>Loading…</EmptyState>}</CardContent>
        </Card>
      </div>
    </>
  );
}

function Metric({ icon: Icon, label, value, unit, accent = "text-muted-foreground", children }: {
  icon: typeof HeartPulse; label: string; value: React.ReactNode; unit?: string; accent?: string; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"><Icon className={cn("size-3", accent)} />{label}</p>
      <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{value}{unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}</p>
      {children}
    </div>
  );
}

function Result({ r, taskId }: { r: Finished; taskId: string }) {
  const { refresh } = useSession();
  const [rpe, setRpe] = useState("");
  const [minutes, setMinutes] = useState("");
  const s = r.session.summary;
  const ok = r.completion?.accepted;
  return (
    <div className={cn("flex flex-col gap-4 rounded-lg border p-4", ok ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5")} role="status">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[["Valid", `${s.valid_minutes} min`], ["Duration", `${s.duration_minutes} min`], ["Quality", `${(s.valid_fraction * 100).toFixed(0)}%`], ["Mean HR", s.hr_mean ?? "—"], ["Peak HR", s.hr_peak ?? "—"]].map(([k, v]) => (
          <div key={k}><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</p><p className="font-mono text-lg tabular-nums">{v}</p></div>
        ))}
      </div>
      {r.completion && (
        <p className={cn("flex items-start gap-2 text-sm", ok ? "text-success" : "text-warning-strong")}>
          {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleX className="mt-0.5 size-4 shrink-0" />}
          {ok ? "Task completed: " : "Task not completed: "}{r.completion.reasons.join("; ")}
        </p>
      )}
      <div className="flex flex-wrap gap-6">
        {r.session.status === "COMPLETED" && (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); api(`/sessions/${r.session.id}/rpe`, { body: { rpe: Number(rpe) } }).then(() => { toast.success("Effort recorded"); refresh(); }).catch((x) => toast.error(x.message)); }}>
            <div className="grid gap-2"><Label htmlFor="rpe">Perceived exertion (Borg 6–20)</Label><Input id="rpe" className="w-28 font-mono" type="number" min={6} max={20} required value={rpe} onChange={(e) => setRpe(e.target.value)} /></div>
            <Button variant="outline">Save effort</Button>
          </form>
        )}
        {r.completion && !ok && r.completion.manual_allowed && taskId && (
          <form className="flex items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            api<{ accepted: boolean; reasons: string[] }>(`/tasks/${taskId}/manual-log`, { body: { duration_min: Number(minutes), rpe: rpe ? Number(rpe) : null } })
              .then((x) => { (x.accepted ? toast.success : toast.warning)(x.reasons.join("; ")); refresh(); }).catch((x) => toast.error(x.message));
          }}>
            <div className="grid gap-2"><Label htmlFor="mins">Manual log · minutes performed</Label><Input id="mins" className="w-28 font-mono" type="number" min={1} max={300} required value={minutes} onChange={(e) => setMinutes(e.target.value)} /></div>
            <Button variant="secondary" className="text-warning-strong">Submit manual log</Button>
          </form>
        )}
      </div>
    </div>
  );
}
