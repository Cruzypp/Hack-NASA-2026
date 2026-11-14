"use client";

import { useState } from "react";
import { Activity, Moon, Radiation } from "lucide-react";
import { toast } from "sonner";
import { api, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SLEEP = [
  ["BAD", "Bad sleep · 5 h"],
  ["REGULAR", "Regular sleep · 7 h"],
  ["GOOD", "Good sleep · 8.5 h"],
  ["ANOMALOUS", "Anomalous sleep · 3 h"],
] as const;
const EXERCISE = [
  ["STANDARD", "Standard · passes"],
  ["SHORT", "Short · fails minimum"],
  ["LOW_QUALITY", "Low quality · fails signal"],
  ["ANOMALOUS", "Anomalous HR"],
  ["PEAKS", "Pronounced HR peaks"],
  ["FAULT", "Sensor fault"],
] as const;
const RADIATION = [
  ["NORMAL", "Normal · 18 µGy/h"],
  ["ELEVATED", "Elevated · 45 µGy/h"],
  ["ANOMALOUS", "Anomalous · 120 µGy/h"],
] as const;
const RADIATION_SCOPE = [
  ["PERSONAL", "Personal · CAD"],
  ["AREA", "Area · REM/HERA"],
] as const;

export function SimulationLab() {
  const { crew, user, refresh } = useSession();
  // The bio-monitor is worn by the signed-in crew member, so exercise sessions are always their own.
  const own = user.crewMemberId === crew;
  const tasks = useData<Task[]>(`/tasks?crew_member_id=${crew}`);
  const [sleep, setSleep] = useState<(typeof SLEEP)[number][0]>("REGULAR");
  const [exercise, setExercise] = useState<(typeof EXERCISE)[number][0]>("STANDARD");
  const [radiation, setRadiation] = useState<(typeof RADIATION)[number][0]>("NORMAL");
  const [radiationScope, setRadiationScope] = useState<(typeof RADIATION_SCOPE)[number][0]>("PERSONAL");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(kind: string, action: () => Promise<unknown>, success: string) {
    setBusy(kind);
    try { await action(); toast.success(success); refresh(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  }

  const exerciseTask = tasks.data?.find((task) => task.task_type === "EXERCISE" && (task.status === "PENDING" || task.status === "OVERDUE"));

  return (
    <Card className="border-primary/25 bg-primary/[0.03]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Activity className="size-4 text-primary" />Simulation lab</CardTitle>
        <CardDescription>Run synthetic cases for {crew} against the task, evidence and baseline pipeline.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-3">
        <SimulationControl icon={Moon} label="Sleep" value={sleep} options={SLEEP} busy={busy === "sleep"}
          onChange={(value) => setSleep(value as typeof sleep)} onRun={() => run("sleep", () => api("/demo/sleep", { body: { scenario: sleep, crew_member_id: crew } }), "Sleep simulation recorded")} />
        <SimulationControl icon={Activity} label={own ? "Exercise" : "Exercise · own sensor only"} value={exercise} options={EXERCISE} busy={busy === "exercise"} disabled={!own}
          onChange={(value) => setExercise(value as typeof exercise)} onRun={() => run("exercise", () => api("/sessions", { body: { task_id: exerciseTask?.id ?? null, scenario: exercise } }), "Exercise simulation started")} />
        <SimulationControl icon={Radiation} label="Radiation" value={radiation} options={RADIATION} secondaryValue={radiationScope} secondaryOptions={RADIATION_SCOPE} busy={busy === "radiation"}
          onChange={(value) => setRadiation(value as typeof radiation)} onSecondaryChange={(value) => setRadiationScope(value as typeof radiationScope)}
          onRun={() => run("radiation", () => api("/demo/radiation", { body: { scenario: radiation, scope: radiationScope, crew_member_id: crew } }), "Radiation reading recorded")} />
      </CardContent>
    </Card>
  );
}

function SimulationControl({ icon: Icon, label, value, options, secondaryValue, secondaryOptions, busy, disabled, onChange, onSecondaryChange, onRun }: {
  icon: typeof Activity; label: string; value: string; options: readonly (readonly [string, string])[];
  secondaryValue?: string; secondaryOptions?: readonly (readonly [string, string])[];
  busy: boolean; disabled?: boolean; onChange: (value: string) => void; onSecondaryChange?: (value: string) => void; onRun: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background/50 p-3">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"><Icon className="size-3.5 text-primary" />{label}</p>
      <div className="mt-3 flex gap-2">
        <Select value={value} onValueChange={onChange} disabled={busy}>
          <SelectTrigger className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent>
        </Select>
        {secondaryOptions && secondaryValue && onSecondaryChange && (
          <Select value={secondaryValue} onValueChange={onSecondaryChange} disabled={busy}>
            <SelectTrigger className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>{secondaryOptions.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Button onClick={onRun} disabled={busy || disabled}>{busy ? "Running…" : "Run"}</Button>
      </div>
    </div>
  );
}
