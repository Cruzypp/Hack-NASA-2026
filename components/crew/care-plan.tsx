"use client";

import { useState } from "react";
import { BellRing, CalendarPlus, ChevronLeft, ChevronRight, History, PencilLine, Plus, Repeat, Square } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, type PlanItem, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { describeRule, describeSchedule } from "@/lib/protocol";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge, TaskIcon } from "@/components/astra";
import { TaskBuilder } from "@/components/crew/task-builder";
import { taskStatusClass } from "@/components/schedule/schedule-status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Plan = { active: PlanItem[]; history: PlanItem[]; can_edit: boolean };
type Builder = { item?: PlanItem; date?: string } | null;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const short = (k: string) => new Date(`${k}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Nov 14 – Nov 20" */
const range = (a: string, b: string) => `${short(a)} – ${short(b)}`;
const addDays = (key: string, n: number) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return dayKey(d); };

export function CarePlan({ crew }: { crew: string }) {
  const { user } = useSession();
  const plan = useData<Plan>(`/crew/${crew}/care-plan`);
  const [builder, setBuilder] = useState<Builder>(null);
  const [retiring, setRetiring] = useState<PlanItem | null>(null);
  if (plan.error) return <ErrorAlert error={plan.error} />;
  if (!plan.data) return <PageSkeleton />;
  const canPlan = plan.data.can_edit;
  const byProtocol = new Map(plan.data.active.map((p) => [p.protocol_id, p]));

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Calendar and care plan · {crew}</p>
            <p className="text-sm text-muted-foreground">
              {canPlan ? "Add one-off or recurring tasks, or edit a recurring task. Each change applies to this crew member only."
                : `Signed in as ${user.name}: you can add one-off tasks. Recurring tasks are set by the flight surgeon.`}
            </p>
          </div>
          <Button size="lg" onClick={() => setBuilder({})}><CalendarPlus />New task</Button>
        </CardContent>
      </Card>

      <WeekCalendar crew={crew} onAdd={(date) => setBuilder({ date })}
        onOpen={(t) => { const p = t.protocol_id && byProtocol.get(t.protocol_id); if (p && canPlan) setBuilder({ item: p }); }} canPlan={canPlan} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Repeat className="size-4 text-primary" />Recurring tasks</CardTitle>
          <CardDescription>{plan.data.active.length} active for {crew}.</CardDescription>
        </CardHeader>
        <CardContent>
          {!plan.data.active.length ? <EmptyState icon={Repeat}>No recurring tasks</EmptyState> : (
            <ul className="flex flex-col divide-y">
              {plan.data.active.map((p) => {
                const when = describeSchedule(p.schedule_type, p.schedule);
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-secondary text-primary">
                      <TaskIcon type={p.task_type} category={p.category} className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {p.name}
                        {p.priority !== "ROUTINE" && <StatusBadge value={p.priority} />}
                        <span className="font-mono text-[11px] font-normal text-muted-foreground">v{p.version}</span>
                      </p>
                      <p className="text-sm text-muted-foreground">{when.when} · {describeRule(p.completion_rule)[0]?.text}</p>
                      {p.change_reason && <p className="truncate text-xs text-muted-foreground" title={p.change_reason}>“{p.change_reason}”</p>}
                    </div>
                    <span className="flex gap-1" title={canPlan ? undefined : "Only the flight surgeon can edit recurring tasks"}>
                      {p.schedule_type !== "EVENT_TRIGGERED" && <Button size="sm" variant="outline" disabled={!canPlan} onClick={() => setBuilder({ item: p })}><PencilLine />Edit</Button>}
                      <Button size="sm" variant="ghost" disabled={!canPlan} onClick={() => setRetiring(p)}><Square />Stop</Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><History className="size-4 text-primary" />Change history</CardTitle>
          <CardDescription>Earlier versions for {crew} and why they changed.</CardDescription>
        </CardHeader>
        <CardContent>
          {!plan.data.history.length ? <EmptyState icon={History}>No changes yet</EmptyState> : (
            <Table>
              <TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Version</TableHead><TableHead>Active</TableHead><TableHead>Why it changed</TableHead></TableRow></TableHeader>
              <TableBody>
                {plan.data.history.map((p) => (
                  <TableRow key={p.id + p.assigned_at}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">v{p.version}</TableCell>
                    <TableCell className="font-mono text-xs">{fmtDate(p.assigned_at)} → {fmtDate(p.ended_at)}</TableCell>
                    <TableCell className="max-w-md whitespace-normal text-xs">{p.end_reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {builder && <TaskBuilder crew={crew} canPlan={canPlan} item={builder.item} initialDate={builder.date} onClose={() => setBuilder(null)} />}
      {retiring && <RetireDialog crew={crew} item={retiring} onClose={() => setRetiring(null)} />}
    </div>
  );
}

function WeekCalendar({ crew, onAdd, onOpen, canPlan }: { crew: string; onAdd: (date: string) => void; onOpen: (t: Task) => void; canPlan: boolean }) {
  const today = dayKey(new Date());
  const [start, setStart] = useState(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const { data } = useData<Task[]>(`/tasks?crew_member_id=${crew}&start=${start}T00:00:00Z&end=${addDays(start, 7)}T00:00:00Z`);
  const tasks = (data ?? []).filter((t) => t.status !== "CANCELLED");
  const label = (k: string) => new Date(`${k}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendar</CardTitle>
        <CardDescription>Click a day to add a task there{canPlan ? "; click a recurring task to edit it" : ""}.</CardDescription>
        <CardAction className="flex items-center gap-1">
          <Button size="icon-sm" variant="outline" aria-label="Previous week" onClick={() => setStart(addDays(start, -7))}><ChevronLeft /></Button>
          <button type="button" onClick={() => setStart(today)} disabled={start === today} title={start === today ? undefined : "Back to this week"}
            className="min-w-36 rounded-md px-2 py-1 text-center text-sm font-semibold tabular-nums enabled:hover:bg-muted" aria-live="polite">
            {range(start, addDays(start, 6))}
          </button>
          <Button size="icon-sm" variant="outline" aria-label="Next week" onClick={() => setStart(addDays(start, 7))}><ChevronRight /></Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {days.map((k) => {
            const list = tasks.filter((t) => t.due_at.slice(0, 10) === k).sort((a, b) => a.due_at.localeCompare(b.due_at));
            const past = k < today;
            return (
              <div key={k} className={cn("flex min-h-48 flex-col rounded-lg border bg-muted/20", k === today && "border-primary/50 bg-primary/5")}>
                <div className="flex items-center justify-between border-b px-2 py-1.5">
                  <span className={cn("text-xs font-semibold", k === today && "text-primary")}>{k === today ? "Today" : label(k)}</span>
                  {!past && (
                    <Button size="icon-xs" variant="ghost" aria-label={`Add task on ${label(k)}`} onClick={() => onAdd(k)}><Plus /></Button>
                  )}
                </div>
                <ul className="flex flex-1 flex-col gap-1 p-1.5">
                  {list.map((t) => {
                    const editable = canPlan && !!t.protocol_id && t.schedule_type !== "EVENT_TRIGGERED";
                    return (
                      <li key={t.id}>
                        <button type="button" onClick={() => onOpen(t)} disabled={!editable}
                          title={`${t.title} · ${t.status.toLowerCase()}`}
                          className={cn("flex w-full items-start gap-1.5 rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight transition-colors",
                            taskStatusClass(t.status), editable ? "hover:ring-2 hover:ring-primary/30" : "cursor-default")}>
                          <TaskIcon type={t.task_type} category={t.category} className="mt-px size-3 shrink-0 text-primary" />
                          <span className="min-w-0 flex-1">
                            <span className="font-mono text-muted-foreground">{t.due_at.slice(11, 16)}</span>{" "}
                            <span className="font-medium">{t.title}</span>
                          </span>
                          {t.source_alert_id ? <BellRing className="mt-px size-3 shrink-0 text-warning-strong" aria-label="Review of alert findings" />
                            : t.schedule_type === "CLINICIAN_ORDERED" && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="One-off" />}
                        </button>
                      </li>
                    );
                  })}
                  {!list.length && <li className="py-4 text-center text-[11px] text-muted-foreground">—</li>}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-warning" />One-off</span>
          <span className="flex items-center gap-1.5"><BellRing className="size-3 text-warning-strong" />CMO review of alert findings (one per crew member, at the daily review time)</span>
          <span className="flex items-center gap-1.5"><Repeat className="size-3" />Others repeat from the care plan</span>
        </p>
      </CardContent>
    </Card>
  );
}

function RetireDialog({ crew, item, onClose }: { crew: string; item: PlanItem; onClose: () => void }) {
  const { refresh } = useSession();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api<{ tasks_cancelled: number }>(`/crew/${crew}/care-plan/${item.protocol_id}/retire`, { body: { reason } });
            toast.success(`Stopped “${item.name}”`, { description: `${r.tasks_cancelled} upcoming task(s) removed from the calendar.` });
            refresh(); onClose();
          } catch (x) { toast.error((x as Error).message); }
        }}>
          <DialogHeader>
            <DialogTitle>Stop “{item.name}” for {crew}</DialogTitle>
            <DialogDescription>Upcoming tasks are removed from the calendar. Past tasks and data are kept.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2"><Label htmlFor="rt-reason">Reason</Label><Textarea id="rt-reason" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="destructive">Stop task</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
