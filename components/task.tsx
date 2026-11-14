"use client";

import Link from "next/link";
import { CircleCheck, CircleX, Clock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, fmtDate, isMedical, type Task } from "@/lib/api";
import { useSession } from "@/lib/session";
import { StatusBadge, TaskIcon } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { humanize, roleLabel } from "@/lib/labels";

type EvidenceResult = { accepted: boolean; reasons: string[] };

export function TaskRow({ task, showDate, hideStatus, hideTechnical, hideNote, hideEvidence, className }: { task: Task; showDate?: boolean; hideStatus?: boolean; hideTechnical?: boolean; hideNote?: boolean; hideEvidence?: boolean; className?: string }) {
  const { user, refresh } = useSession();
  const open = task.status === "PENDING" || task.status === "OVERDUE";
  const mine = user.crewMemberId === task.crew_member_id;
  const last = task.evidence?.at(-1);

  async function dosimeter() {
    try {
      const r = await api<EvidenceResult>(`/tasks/${task.id}/dosimeter-check`, { method: "POST" });
      (r.accepted ? toast.success : toast.warning)(r.accepted ? "Dosimeter verified" : "Check not accepted", { description: r.reasons.join("; ") });
      refresh();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <li className={cn("group flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/40", className)}>
      <div className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border",
        task.status === "COMPLETED" ? "border-success/30 bg-success/10 text-success"
          : task.status === "OVERDUE" ? "border-warning/30 bg-warning/10 text-warning-strong" : "border-border bg-muted/50 text-muted-foreground")}>
        <TaskIcon type={task.task_type} category={task.category} className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{task.title}</span>
          {!hideStatus && task.priority !== "ROUTINE" && <StatusBadge value={task.priority} />}
          {!hideStatus && <StatusBadge value={task.status} dot />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-mono"><Clock className="size-3" aria-hidden />{showDate ? fmtDate(task.due_at) : fmtDate(task.due_at).split(", ").at(-1)}</span>
          <span>{humanize(task.schedule_type)}</span>
          {!hideTechnical && task.protocol_version_id && <span className="font-mono">{task.protocol_version_id}</span>}
        </div>
        {!hideEvidence && last && (
          <p className={cn("flex items-start gap-1.5 text-xs", last.accepted ? "text-success" : "text-warning-strong")}>
            {last.accepted ? <CircleCheck className="mt-px size-3.5 shrink-0" /> : <CircleX className="mt-px size-3.5 shrink-0" />}
            {last.reasons?.join("; ")}
          </p>
        )}
        {!hideNote && task.note && <p className="text-xs text-muted-foreground">{task.note}</p>}
      </div>
      {open && (
        <div className="flex shrink-0 items-start gap-2">
          {mine && task.task_type === "EXERCISE" && <Button size="sm" asChild><Link href={`/exercise?task=${task.id}`}>Start</Link></Button>}
          {mine && task.task_type === "MEASUREMENT" && task.completionCriteria.metric && (
            <Button size="sm" asChild><Link href={`/measurements?metric=${task.completionCriteria.metric}&task=${task.id}`}>Record</Link></Button>
          )}
          {mine && task.task_type === "DEVICE_CHECK" && <Button size="sm" onClick={dosimeter}>Verify</Button>}
          {mine && task.task_type === "RADIATION_READING" && <Button size="sm" asChild><Link href="/measurements?tab=radiation">Log reading</Link></Button>}
          {mine && task.task_type === "RECREATION" && <ActivityDialog task={task} />}
          {isMedical(user.role) && task.completionCriteria.kind === "VERIFICATION" && <VerifyDialog task={task} />}
        </div>
      )}
    </li>
  );
}

function ActivityDialog({ task }: { task: Task }) {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const planned = Number(task.completionCriteria.min_minutes ?? 0);
  const [minutes, setMinutes] = useState(String(planned || 30));
  const [note, setNote] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<EvidenceResult>(`/tasks/${task.id}/activity`, { body: { duration_min: Number(minutes), note: note || null } });
      (r.accepted ? toast.success : toast.warning)(r.accepted ? "Marked as done" : "Not completed yet", { description: r.reasons.join("; ") });
      if (r.accepted) { setOpen(false); refresh(); }
    } catch (x) { toast.error((x as Error).message); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">Mark done</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{task.title}</DialogTitle>
            <DialogDescription>{planned ? `Planned: at least ${planned} min.` : "Log how long you spent on it."}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`act-min-${task.id}`}>Minutes</Label>
            <Input id={`act-min-${task.id}`} type="number" min={0} max={600} required className="w-28 font-mono" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`act-note-${task.id}`}>Note (optional)</Label>
            <Textarea id={`act-note-${task.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Movie night with the crew" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VerifyDialog({ task }: { task: Task }) {
  const { refresh, user } = useSession();
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<EvidenceResult>(`/tasks/${task.id}/verify`, { body: { note } });
      if (r.accepted) {
        toast.success("Verification signed", { description: task.source_alert_id ? "Linked alert resolved." : r.reasons.join("; ") });
        setOpen(false); setNote(""); refresh();
      } else toast.warning("Verification not accepted", { description: r.reasons.join("; ") });
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="secondary" className="border-warning/40 text-warning-strong">Verify</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{task.title}</DialogTitle>
            <DialogDescription>
              Signed as {user.name} ({roleLabel(user.role)}). This is recorded in the audit log and synced to ground.
              {task.source_alert_id && " The linked alert will be resolved."}
            </DialogDescription>
          </DialogHeader>
          {task.note && <p className="rounded-md bg-muted/50 p-3 text-sm">{task.note}</p>}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`note-${task.id}`}>Verification note</Label>
            <Textarea id={`note-${task.id}`} required minLength={3} rows={4} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="What was checked, how, and the outcome." />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy}>{busy ? "Signing…" : "Sign verification"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
