"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CircleCheck, FileUp, History, Lightbulb, PenLine, ScanSearch, Radiation } from "lucide-react";
import { toast } from "sonner";
import { api, type Measurement } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, PageHeader, StatusBadge } from "@/components/astra";
import { MeasurementTable } from "@/components/tables";
import { RadiationPanel } from "@/components/radiation-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { factorLabel, metricLabel } from "@/lib/labels";

type Metric = { unit: string; range: [number, number]; label: string };
type Result = {
  measurement: Measurement;
  completion?: { accepted: boolean; reasons: string[] };
  assessment: { status: string; z?: number; summary?: string; detail?: string; recommendation?: string;
    baseline?: { n: number; median?: number; robust_sd?: number }; context?: { factor: string; detail: string; effect: string }[]; follow_up_task_id?: string };
};

export function View() {
  return <Suspense><Measurements /></Suspense>;
}

function Measurements() {
  const params = useSearchParams();
  const { user, crew } = useSession();
  const history = useData<Measurement[]>(`/measurements?crew_member_id=${crew}&include_superseded=true`);
  const [result, setResult] = useState<Result | null>(null);
  const [shown, setShown] = useState(25);
  const own = user.crewMemberId === crew;

  return (
    <>
      <PageHeader title="Measurements" description="Manual entry, imports and sensor-derived values with quality and full correction history. Every value is checked against the crew member's own baseline." />
      {own ? (
        <div className="grid gap-4 lg:grid-cols-5">
          <EntryForm className="lg:col-span-2" initialMetric={params.get("metric") ?? "resting_hr"} taskId={params.get("task")} onResult={setResult} />
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ScanSearch className="size-4 text-primary" />Assessment</CardTitle>
              <CardDescription>Baseline check, context and task evidence for the last value recorded.</CardDescription>
            </CardHeader>
            <CardContent>{result ? <Assessment r={result} /> : <EmptyState icon={ScanSearch}>Record a value to see how it compares with the personal baseline.</EmptyState>}</CardContent>
          </Card>
        </div>
      ) : <p className="text-sm text-muted-foreground">Viewing {crew}. Manual entry is done by the crew member; you can correct values below.</p>}

      <Tabs defaultValue={params.get("tab") ?? "history"}>
        <TabsList>
          <TabsTrigger value="history"><History />History</TabsTrigger>
          <TabsTrigger value="radiation"><Radiation />Radiation</TabsTrigger>
          {own && <TabsTrigger value="import"><FileUp />Import</TabsTrigger>}
        </TabsList>
        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader><CardTitle>History · {crew}</CardTitle><CardDescription>Corrections never overwrite: the original stays visible as superseded.</CardDescription></CardHeader>
            <CardContent>
              <MeasurementTable rows={(history.data ?? []).slice(0, shown)}
                actions={(m) => !m.superseded && (own || user.role !== "ASTRONAUT") ? <CorrectDialog m={m} /> : null} />
              {(history.data?.length ?? 0) > shown && (
                <div className="mt-3 flex justify-center">
                  <Button variant="outline" size="sm" onClick={() => setShown((n) => n + 25)}>Show more · {history.data!.length - shown} older</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="radiation" className="mt-4"><RadiationPanel /></TabsContent>
        {own && <TabsContent value="import" className="mt-4"><Import /></TabsContent>}
      </Tabs>
    </>
  );
}

function EntryForm({ initialMetric, taskId, onResult, className }: { initialMetric: string; taskId: string | null; onResult: (r: Result) => void; className?: string }) {
  const { refresh } = useSession();
  const metrics = useData<Record<string, Metric>>("/metrics");
  const [metric, setMetric] = useState(initialMetric);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const m = metrics.data?.[metric];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<Result>("/measurements", { body: { metric, value: Number(value), note: note || null, task_id: taskId } });
      onResult(r); setValue(""); setNote(""); refresh();
      if (r.assessment.status === "DEVIATION") toast.warning("Value outside personal baseline", { description: "Follow-up created for medical review." });
      else toast.success("Measurement recorded");
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PenLine className="size-4 text-primary" />Manual entry</CardTitle>
        <CardDescription>{taskId ? <>Linked to task <span className="font-mono">{taskId}</span></> : "Matched automatically to today's open task for this metric."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Metric</Label>
            <Select value={metric} onValueChange={setMetric}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(metrics.data ?? {}).filter(([k]) => k !== "heart_rate").map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="value">Value</Label>
            <div className="relative">
              <Input id="value" type="number" step="any" required min={m?.range[0]} max={m?.range[1]} value={value} onChange={(e) => setValue(e.target.value)} className="h-12 pr-16 font-mono text-2xl tabular-nums" />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-sm text-muted-foreground">{m?.unit}</span>
            </div>
            {m && <p className="text-[11px] text-muted-foreground">Accepted range {m.range[0]}–{m.range[1]} {m.unit}.</p>}
          </div>
          <div className="grid gap-2"><Label htmlFor="note">Note (optional)</Label><Textarea id="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. seated, after 5 min rest" /></div>
          <Button size="lg" disabled={busy}>{busy ? "Recording…" : "Record measurement"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Assessment({ r }: { r: Result }) {
  const a = r.assessment;
  return (
    <div className="flex flex-col gap-4" role="status">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-3xl font-semibold tabular-nums">{r.measurement.value}<span className="ml-1 text-sm text-muted-foreground">{r.measurement.unit}</span></span>
        <StatusBadge value={a.status} dot />
        <StatusBadge value={r.measurement.quality} />
      </div>
      {a.baseline?.median !== undefined && (
        <dl className="grid grid-cols-3 gap-2">
          {[["Baseline median", a.baseline.median], ["Robust SD", a.baseline.robust_sd], ["Robust z", a.z !== undefined ? (a.z > 0 ? `+${a.z}` : a.z) : "—"]].map(([k, v]) => (
            <div key={k} className="rounded-md bg-muted/50 px-3 py-2"><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt><dd className="font-mono tabular-nums">{v}</dd></div>
          ))}
        </dl>
      )}
      {a.summary && <p className="text-sm">{a.summary}</p>}
      {a.detail && <p className="text-sm text-muted-foreground">{a.detail}</p>}
      {a.context?.map((c) => (
        <div key={c.factor} className="rounded-md border px-3 py-2 text-xs"><span className="font-medium text-primary">{factorLabel(c.factor)}</span> · {c.detail}<p className="mt-0.5 text-muted-foreground">{c.effect}</p></div>
      ))}
      {a.recommendation && <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-strong"><Lightbulb className="mt-0.5 size-4 shrink-0" />{a.recommendation}</p>}
      {r.completion && (
        <p className={`flex items-start gap-2 text-sm ${r.completion.accepted ? "text-success" : "text-warning-strong"}`}>
          <CircleCheck className="mt-0.5 size-4 shrink-0" />Task evidence: {r.completion.reasons.join("; ")}
        </p>
      )}
      {a.follow_up_task_id && <p className="text-xs text-muted-foreground">Follow-up task <span className="font-mono">{a.follow_up_task_id}</span> assigned to the Crew Medical Officer.</p>}
    </div>
  );
}

function CorrectDialog({ m }: { m: Measurement }) {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(m.value));
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="xs" variant="ghost">Correct</Button></DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault();
          try { await api(`/measurements/${m.id}/correct`, { body: { value: Number(value), reason } }); toast.success("Correction recorded"); setOpen(false); refresh(); }
          catch (x) { toast.error((x as Error).message); }
        }}>
          <DialogHeader>
            <DialogTitle>Correct {metricLabel(m.metric).toLowerCase()}</DialogTitle>
            <DialogDescription>The original value ({m.value} {m.unit}) is kept as superseded and the change is audited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2"><Label htmlFor={`v-${m.id}`}>Corrected value ({m.unit})</Label><Input id={`v-${m.id}`} type="number" step="any" required className="font-mono" value={value} onChange={(e) => setValue(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor={`r-${m.id}`}>Reason</Label><Textarea id={`r-${m.id}`} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. transcription error" /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button>Save correction</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Import() {
  const { refresh } = useSession();
  const [csv, setCsv] = useState("metric,value,measured_at\nbody_temp,36.7,2026-01-01T07:30:00Z\n");
  const [out, setOut] = useState<{ accepted: string[]; rejected: { line: number; error: string }[] } | null>(null);
  return (
    <Card>
      <CardHeader><CardTitle>Import results (CSV)</CardTitle><CardDescription>Columns: <span className="font-mono">metric,value,measured_at</span>. Each line is validated independently and stored with source IMPORT.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea aria-label="CSV data" rows={6} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => api<typeof out>("/measurements/import", { body: { csv } }).then((r) => { setOut(r); refresh(); toast.success(`${r!.accepted.length} rows imported`); }).catch((x) => toast.error(x.message))}><FileUp />Import</Button>
          {out && <span className="text-sm text-muted-foreground">{out.accepted.length} accepted · {out.rejected.length} rejected</span>}
        </div>
        {!!out?.rejected.length && <ul className="text-xs text-destructive">{out.rejected.map((r) => <li key={r.line}>Line {r.line}: {r.error}</li>)}</ul>}
      </CardContent>
    </Card>
  );
}
