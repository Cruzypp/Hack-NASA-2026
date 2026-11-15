"use client";

import { useState } from "react";
import { Check, Plus, Zap } from "lucide-react";
import { toast } from "sonner";
import { api, type PlanItem } from "@/lib/api";
import { useSession } from "@/lib/session";
import { metricLabel } from "@/lib/labels";
import { describeRule, describeSchedule, WEEKDAYS } from "@/lib/protocol";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Kind = "MEASUREMENT" | "RADIATION_READING" | "AUTOMATED_REVIEW" | "TELEMETRY_SESSION" | "VERIFICATION" | "ACTIVITY";
type Pattern = "once" | "daily" | "weekdays" | "every" | "mission";
type Draft = {
  name: string; kind: Kind; metric: string; autoCapture: boolean; allowManual: boolean; manualOnly: boolean; windowDays: number;
  minMinutes: number; recMinutes: number; pattern: Pattern; date: string; weekdays: number[]; everyDays: number; missionDays: number[];
  times: string[]; priority: string; reference: string; reason: string;
};

const KINDS: { value: Kind; label: string }[] = [
  { value: "MEASUREMENT", label: "Measurement" },
  { value: "RADIATION_READING", label: "Radiation reading" },
  { value: "AUTOMATED_REVIEW", label: "Automated deviation review" },
  { value: "TELEMETRY_SESSION", label: "Exercise session" },
  { value: "VERIFICATION", label: "CMO review / clinical check" },
  { value: "ACTIVITY", label: "Recreation" },
];
const MEASURE_METRICS = ["resting_hr", "systolic_bp", "diastolic_bp", "body_temp", "body_mass", "sleep_hours"];
const REVIEW_METRICS = ["resting_hr", "sleep_hours", "systolic_bp", "diastolic_bp", "body_temp", "body_mass"];
const PATTERNS: { value: Pattern; label: string }[] = [
  { value: "once", label: "Once" }, { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Days of the week" }, { value: "every", label: "Every N days" },
];

const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const blank = (pattern: Pattern): Draft => ({
  name: "", kind: "MEASUREMENT", metric: "resting_hr", autoCapture: false, allowManual: true, manualOnly: false, windowDays: 7,
  minMinutes: 25, recMinutes: 30, pattern, date: tomorrow(), weekdays: [1], everyDays: 2, missionDays: [], times: ["08:00"],
  priority: "ROUTINE", reference: "", reason: "",
});

const PRESETS: { label: string; draft: Partial<Draft> }[] = [
  { label: "Automatic pulse daily 08:00", draft: { name: "Morning resting heart rate (automatic)", kind: "MEASUREMENT", metric: "resting_hr", autoCapture: true, pattern: "daily", times: ["08:00"] } },
  { label: "Weekly pulse deviation review", draft: { name: "Weekly resting heart rate deviation review", kind: "AUTOMATED_REVIEW", metric: "resting_hr", windowDays: 7, pattern: "weekdays", weekdays: [7], times: ["20:00"] } },
  { label: "Daily recreation 19:00", draft: { name: "Recreation time", kind: "ACTIVITY", recMinutes: 30, pattern: "daily", times: ["19:00"] } },
  { label: "Weekly radiation readout", draft: { name: "Weekly passive dosimeter readout", kind: "RADIATION_READING", manualOnly: true, pattern: "weekdays", weekdays: [3], times: ["09:00"], priority: "HIGH" } },
];

function toSchedule(d: Draft): { type: string; schedule: Record<string, unknown> } {
  if (d.pattern === "mission") return { type: "MISSION_RELATIVE", schedule: { mission_days: d.missionDays, at: d.times[0] } };
  if (d.pattern === "weekdays") return { type: "RECURRENT", schedule: { weekdays: d.weekdays, at: d.times } };
  return { type: "RECURRENT", schedule: { every_days: d.pattern === "every" ? d.everyDays : 1, at: d.times } };
}

function toRule(d: Draft): Record<string, unknown> & { kind: string } {
  switch (d.kind) {
    case "MEASUREMENT": return { kind: d.kind, metric: d.metric, auto_capture: d.metric === "resting_hr" && d.autoCapture, allow_manual: d.allowManual };
    case "RADIATION_READING": return { kind: d.kind, manual_only: d.manualOnly };
    case "AUTOMATED_REVIEW": return { kind: d.kind, metric: d.metric, window_days: d.windowDays };
    case "TELEMETRY_SESSION": return { kind: d.kind, metric: "heart_rate", min_valid_minutes: d.minMinutes, manual_fallback: d.allowManual };
    case "VERIFICATION": return { kind: d.kind, roles: ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"] };
    case "ACTIVITY": return { kind: d.kind, min_minutes: d.recMinutes };
  }
}

function fromItem(p: PlanItem): Draft {
  const s = p.schedule as { every_days?: number; weekdays?: number[]; at: string[] | string; mission_days?: number[] };
  const r = p.completion_rule as Record<string, unknown>;
  const pattern: Pattern = p.schedule_type === "MISSION_RELATIVE" ? "mission" : s.weekdays ? "weekdays" : s.every_days === 1 ? "daily" : "every";
  return {
    ...blank(pattern), name: p.name, kind: r.kind as Kind, metric: String(r.metric ?? "resting_hr"), autoCapture: !!r.auto_capture,
    allowManual: r.allow_manual !== undefined ? !!r.allow_manual : !!r.manual_fallback, manualOnly: !!r.manual_only,
    windowDays: Number(r.window_days ?? 7), minMinutes: Number(r.min_valid_minutes ?? 25), recMinutes: Number(r.min_minutes ?? 30),
    weekdays: s.weekdays ?? [1], everyDays: s.every_days ?? 2, missionDays: s.mission_days ?? [],
    times: Array.isArray(s.at) ? s.at : [s.at], priority: p.priority,
  };
}

/**
 * Adds a task to a crew member's calendar. "Once" creates a one-off clinician-ordered task
 * (CMO or flight surgeon); any recurrence creates or revises a care-plan protocol (flight surgeon only).
 */
export function TaskBuilder({ crew, item, canPlan, initialDate, onClose }: {
  crew: string; item?: PlanItem; canPlan: boolean; initialDate?: string; onClose: () => void;
}) {
  const { refresh } = useSession();
  const revise = !!item;
  const [d, setD] = useState<Draft>(item ? fromItem(item) : { ...blank(canPlan ? "daily" : "once"), date: initialDate ?? tomorrow() });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const once = d.pattern === "once";
  const sched = toSchedule(d);
  const rule = toRule(d);
  const when = once
    ? { when: `Once on ${new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })} at ${d.times[0]}Z`, detail: "One-off task" }
    : describeSchedule(sched.type, sched.schedule);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (d.pattern === "weekdays" && !d.weekdays.length) return toast.error("Pick at least one day of the week");
    setBusy(true);
    try {
      if (once) {
        await api("/tasks", { body: { crew_member_id: crew, title: d.name, due_at: new Date(`${d.date}T${d.times[0]}:00Z`).toISOString(),
          priority: d.priority, completion_rule: rule, note: d.reason || null } });
        toast.success("Task added to the calendar");
      } else if (revise) {
        const v = await api<{ version: string }>(`/crew/${crew}/care-plan/${item!.protocol_id}/revise`,
          { body: { schedule_type: sched.type, schedule: sched.schedule, completion_rule: rule, priority: d.priority, reason: d.reason } });
        toast.success(`Updated to v${v.version}`, { description: "Upcoming tasks were replaced for this crew member." });
      } else {
        await api(`/crew/${crew}/care-plan`, { body: { name: d.name, schedule_type: sched.type, schedule: sched.schedule, completion_rule: rule,
          priority: d.priority, reference: d.reference, reason: d.reason } });
        toast.success("Recurring task added", { description: "Scheduled from now on." });
      }
      refresh(); onClose();
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{revise ? `Edit “${item!.name}”` : `New task for ${crew}`}</DialogTitle>
            <DialogDescription>
              {revise ? `Saves a new version for ${crew} (now v${item!.version}); other crew members are not affected.`
                : canPlan ? "Choose what, when and how often." : "As CMO you can add one-off tasks. Recurring tasks are set by the flight surgeon."}
            </DialogDescription>
          </DialogHeader>

          {!revise && canPlan && (
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button key={p.label} type="button" size="sm" variant="secondary"
                  onClick={() => setD({ ...blank("daily"), ...p.draft, reference: d.reference, reason: d.reason })}>
                  <Zap />{p.label}
                </Button>
              ))}
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              {!revise && <Field label="Task name" id="tb-name"><Input id="tb-name" required minLength={3} value={d.name} onChange={(e) => set("name", e.target.value)} /></Field>}

              <Field label="What">
                <Select value={d.kind} onValueChange={(v) => set("kind", v as Kind)} disabled={revise}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {(d.kind === "MEASUREMENT" || d.kind === "AUTOMATED_REVIEW") && (
                <Field label="Metric">
                  <Select value={d.metric} onValueChange={(v) => set("metric", v)} disabled={revise}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{(d.kind === "MEASUREMENT" ? MEASURE_METRICS : REVIEW_METRICS).map((m) => <SelectItem key={m} value={m}>{metricLabel(m)}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              {d.kind === "MEASUREMENT" && (
                <>
                  <Toggle id="tb-auto" checked={d.autoCapture && d.metric === "resting_hr"} disabled={d.metric !== "resting_hr"} onChange={(v) => set("autoCapture", v)}
                    label={d.metric === "resting_hr" ? "Capture automatically from the heart-rate sensor" : "Automatic capture not available for this metric"} />
                  <Toggle id="tb-manual" checked={d.allowManual} onChange={(v) => set("allowManual", v)} label="Allow manual entry" />
                </>
              )}
              {d.kind === "RADIATION_READING" && <Toggle id="tb-ro" checked={d.manualOnly} onChange={(v) => set("manualOnly", v)} label="Require a manual dosimeter readout" />}
              {d.kind === "AUTOMATED_REVIEW" && (
                <Field label="Look back (days)" id="tb-win"><Input id="tb-win" type="number" min={1} max={31} className="w-24 font-mono" value={d.windowDays} onChange={(e) => set("windowDays", Number(e.target.value))} /></Field>
              )}
              {d.kind === "ACTIVITY" && (
                <Field label="Minimum time (min, 0 = any)" id="tb-rec"><Input id="tb-rec" type="number" min={0} max={600} className="w-28 font-mono" value={d.recMinutes} onChange={(e) => set("recMinutes", Number(e.target.value))} /></Field>
              )}
              {d.kind === "TELEMETRY_SESSION" && (
                <Field label="Minimum duration (min)" id="tb-min"><Input id="tb-min" type="number" min={5} max={240} className="w-28 font-mono" value={d.minMinutes} onChange={(e) => set("minMinutes", Number(e.target.value))} /></Field>
              )}

              <Field label="How often">
                {d.pattern === "mission" ? <p className="text-sm text-muted-foreground">On specific mission days (kept as is)</p> : (
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4" role="radiogroup" aria-label="Recurrence">
                    {PATTERNS.filter((p) => !(revise && p.value === "once")).map((p) => {
                      const locked = p.value !== "once" && !canPlan;
                      return (
                        <button key={p.value} type="button" role="radio" aria-checked={d.pattern === p.value} disabled={locked}
                          title={locked ? "Recurring tasks are set by the flight surgeon" : undefined}
                          onClick={() => set("pattern", p.value)}
                          className={cn("rounded-md px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                            d.pattern === p.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {!canPlan && !revise && (
                  <p className="text-xs text-warning-strong">You are signed in as Crew Medical Officer: only one-off tasks. Recurring tasks are created and edited by the flight surgeon (Dr. S. Lindqvist).</p>
                )}
              </Field>
              {once && <Field label="Date (UTC)" id="tb-date"><Input id="tb-date" type="date" required min={new Date().toISOString().slice(0, 10)} value={d.date} onChange={(e) => set("date", e.target.value)} /></Field>}
              {d.pattern === "weekdays" && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Days of the week">
                  {WEEKDAYS.map((w, i) => {
                    const on = d.weekdays.includes(i + 1);
                    return (
                      <button key={w} type="button" aria-pressed={on} onClick={() => set("weekdays", on ? d.weekdays.filter((x) => x !== i + 1) : [...d.weekdays, i + 1].sort())}
                        className={cn("h-9 w-11 rounded-md border text-xs font-medium transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                        {w}
                      </button>
                    );
                  })}
                </div>
              )}
              {d.pattern === "every" && (
                <Field label="Every how many days" id="tb-n"><Input id="tb-n" type="number" min={2} max={365} className="w-24 font-mono" value={d.everyDays} onChange={(e) => set("everyDays", Number(e.target.value))} /></Field>
              )}
              <Field label="Time (UTC)">
                <div className="flex flex-wrap items-center gap-2">
                  {(once ? d.times.slice(0, 1) : d.times).map((t, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <Input type="time" required aria-label={`Time ${i + 1}`} className="w-36 font-mono" value={t}
                        onChange={(e) => set("times", d.times.map((x, j) => (j === i ? e.target.value : x)))} />
                      {!once && d.times.length > 1 && <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove time" onClick={() => set("times", d.times.filter((_, j) => j !== i))}>×</Button>}
                    </span>
                  ))}
                  {!once && d.pattern !== "mission" && d.times.length < 6 && <Button type="button" size="xs" variant="ghost" onClick={() => set("times", [...d.times, "20:00"])}><Plus />Add time</Button>}
                </div>
              </Field>
              <Field label="Priority">
                <Select value={d.priority} onValueChange={(v) => set("priority", v)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{["ROUTINE", "HIGH", "CRITICAL"].map((p) => <SelectItem key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded-lg border bg-muted/40 p-4">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Preview</p>
                <p className="mt-1 font-semibold">{d.name || item?.name || "New task"}</p>
                <p className="mt-2 text-sm">{when.when}</p>
                {when.detail && <p className="text-xs text-muted-foreground">{when.detail}</p>}
                <ul className="mt-3 flex flex-col gap-1">
                  {describeRule(rule).map((r) => (
                    <li key={r.text} className={cn("flex items-start gap-2 text-sm", r.optional && "text-muted-foreground")}>
                      <Check className={cn("mt-0.5 size-3.5 shrink-0", r.optional ? "text-muted-foreground" : "text-success")} />{r.text}
                    </li>
                  ))}
                </ul>
              </div>
              {!revise && !once && (
                <Field label="Reference" id="tb-ref">
                  <Input id="tb-ref" required minLength={3} value={d.reference} onChange={(e) => set("reference", e.target.value)} placeholder="e.g. Individual medical plan, section 4.2" />
                </Field>
              )}
              <Field label={once ? "Instructions for the crew member (optional)" : "Reason"} id="tb-reason">
                <Textarea id="tb-reason" required={!once} minLength={once ? undefined : 3} rows={4} value={d.reason} onChange={(e) => set("reason", e.target.value)}
                  placeholder={once ? "e.g. Seated, after 5 min rest" : "Why this task is needed. Saved with the plan and in the logbook."} />
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={busy}>{busy ? "Saving…" : revise ? "Save changes" : "Add to calendar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

function Toggle({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className={cn("font-normal", disabled && "text-muted-foreground")}>{label}</Label>
    </div>
  );
}
