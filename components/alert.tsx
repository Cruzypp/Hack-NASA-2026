"use client";

import Link from "next/link";
import { BrainCircuit, CircleCheck, Cpu, HeartPulse, Lightbulb } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, fmtDate, isMedical, type Alert } from "@/lib/api";
import { useSession } from "@/lib/session";
import { StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { factorLabel, humanize } from "@/lib/labels";

export function AlertCard({ alert, compact }: { alert: Alert; compact?: boolean }) {
  const { user, refresh } = useSession();
  const e = alert.explanation;
  const medical = alert.category === "MEDICAL";
  const Icon = medical ? HeartPulse : Cpu;
  const obs = e.observation as { value: number; unit: string } | undefined;
  const canResolve = alert.status !== "RESOLVED" && !alert.follow_up_task_id &&
    (medical ? isMedical(user.role) : user.role !== "ASTRONAUT");

  async function ack() {
    try { await api(`/alerts/${alert.id}/ack`, { method: "POST" }); toast.success("Alert acknowledged"); refresh(); }
    catch (x) { toast.error((x as Error).message); }
  }

  if (compact) {
    return (
      <div className={cn("flex gap-3 rounded-lg border p-3", medical ? "border-warning/30 bg-warning/5" : "border-border bg-muted/30")}>
        <Icon className={cn("mt-0.5 size-4 shrink-0", medical ? "text-warning-strong" : "text-muted-foreground")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{alert.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{e.summary ?? humanize(alert.type)}</p>
        </div>
        <StatusBadge value={alert.status} />
      </div>
    );
  }

  return (
    <Card className={cn(medical && alert.status !== "RESOLVED" && "ring-warning/30")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className={cn("size-4", medical ? "text-warning-strong" : "text-muted-foreground")} aria-hidden />
          {alert.title}
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          {fmtDate(alert.created_at)} · {humanize(alert.type)}{alert.rule_id && ` · ${alert.rule_id}@${alert.rule_version}`}
        </CardDescription>
        <CardAction className="flex gap-1.5"><StatusBadge value={alert.category} /><StatusBadge value={alert.status} dot /></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {e.summary && <p className="text-sm">{e.summary}</p>}
        {!!e.findings?.length && (
          <ul className="flex flex-col gap-1.5">
            {e.findings.map((f) => (
              <li key={f.code} className="rounded-md border px-3 py-2 text-xs">
                <span className="flex flex-wrap items-center gap-2"><StatusBadge value={f.level} tone={f.level === "ACTION" ? "danger" : f.level === "REVIEW" ? "warn" : "info"} /><span className="font-medium">{f.title}</span></span>
                <span className="mt-1 block font-mono text-muted-foreground">{f.observation}</span>
                {isMedical(user.role) && <span className="mt-0.5 block">{f.action} · <span className="text-muted-foreground">{f.responsible}</span></span>}
              </li>
            ))}
          </ul>
        )}
        {alert.type === "BODY_COMPOSITION_FINDINGS" && <Button size="sm" variant="outline" className="self-start" asChild><Link href="/body">Open body composition</Link></Button>}
        {e.baseline && obs && e.z !== undefined && (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Observed", `${obs.value} ${obs.unit}`], ["Baseline", `${e.baseline.median} ± ${e.baseline.robust_sd}`], ["Robust z", e.z > 0 ? `+${e.z}` : e.z], ["Points", e.baseline.n]].map(([k, v]) => (
              <div key={k} className="rounded-md bg-muted/50 px-3 py-2">
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
                <dd className="font-mono text-sm font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {!!e.context?.length && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Context</p>
            {e.context.map((c) => (
              <div key={c.factor} className="rounded-md border border-border px-3 py-2 text-xs">
                <span className="font-medium text-primary">{factorLabel(c.factor)}</span> · {c.detail}
                <p className="mt-0.5 text-muted-foreground">{c.effect}</p>
              </div>
            ))}
          </div>
        )}
        {e.advisory_model && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <BrainCircuit className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{e.advisory_model.version}: {e.advisory_model.status === "RAN"
              ? `score ${e.advisory_model.score} (${e.advisory_model.outlier ? "outlier" : "inlier"})` : e.advisory_model.status}. {e.advisory_model.note}</span>
          </p>
        )}
        {e.recommendation && (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong">
            <Lightbulb className="mt-0.5 size-4 shrink-0" aria-hidden />{e.recommendation}
          </p>
        )}
        {!e.summary && (
          <dl className="grid gap-1 text-xs">
            {Object.entries(e).map(([k, v]) => (
              <div key={k} className="flex gap-2"><dt className="w-32 shrink-0 text-muted-foreground">{humanize(k)}</dt><dd className="break-all">{String(v)}</dd></div>
            ))}
          </dl>
        )}
        {alert.resolution_note && (
          <p className="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-xs text-success">
            <CircleCheck className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>Resolved by <span className="font-mono">{alert.resolved_by}</span>: {alert.resolution_note}</span>
          </p>
        )}
      </CardContent>
      {alert.status !== "RESOLVED" && (
        <CardFooter className="flex flex-wrap items-center gap-2 border-t">
          {alert.status === "OPEN" && user.role !== "ASTRONAUT" && <Button size="sm" variant="outline" onClick={ack}>Acknowledge</Button>}
          {canResolve && <ResolveDialog alert={alert} />}
          {alert.follow_up_task_id && <p className="text-xs text-muted-foreground">Resolves when follow-up <span className="font-mono">{alert.follow_up_task_id}</span> is verified.</p>}
        </CardFooter>
      )}
    </Card>
  );
}

function ResolveDialog({ alert }: { alert: Alert }) {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">Resolve</Button></DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={async (ev) => {
          ev.preventDefault();
          try { await api(`/alerts/${alert.id}/resolve`, { body: { note } }); toast.success("Alert resolved"); setOpen(false); refresh(); }
          catch (x) { toast.error((x as Error).message); }
        }}>
          <DialogHeader>
            <DialogTitle>Resolve alert</DialogTitle>
            <DialogDescription>{alert.title}. The resolution is audited and synced.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`res-${alert.id}`}>Resolution note</Label>
            <Textarea id={`res-${alert.id}`} required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button>Resolve</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
