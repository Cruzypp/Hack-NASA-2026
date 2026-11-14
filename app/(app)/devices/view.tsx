"use client";

import { useState } from "react";
import { CloudUpload, Radiation, RadioTower, RotateCcw, Rocket, Satellite } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, type SyncState } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, PageHeader, StatTile, StatusBadge } from "@/components/astra";
import { type Device } from "@/components/tables";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { humanize } from "@/lib/labels";

type Radiation = { readings: { id: string; measured_at: string; dose_rate_uGy_h: number; cumulative_uGy: number; eva_id: string | null }[];
  eva: { id: string; planned_start: string; planned_end: string }[]; note: string };

export function View() {
  const { user, crew, refresh } = useSession();
  const devices = useData<Device[]>("/devices");
  const sync = useData<SyncState>("/sync");
  const rad = useData<Radiation>(user.role === "MISSION_OPERATOR" ? null : `/radiation/${crew}`);
  const s = sync.data;

  async function setLink(aos: boolean) {
    try {
      const r = await api<{ sent: number; pending: number }>("/sync/link", { body: { state: aos ? "AOS" : "LOS" } });
      (aos ? toast.success : toast.warning)(aos ? `AOS · ${r.sent} events replicated` : "LOS · queuing locally");
      refresh();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="Devices & sync" description="Adapter catalogue and store-and-forward replication to ground." />
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Satellite className="size-4 text-primary" />Ground link</CardTitle>
            <CardDescription>The onboard node keeps working during loss of signal. Every change is queued in the outbox and replayed in order, idempotently, at acquisition.</CardDescription>
          </CardHeader>
          <CardContent>
            {s && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-4 rounded-lg border p-4">
                  <div className={cn("flex size-12 items-center justify-center rounded-full border-2", s.link === "AOS" ? "border-success text-success" : "border-warning text-warning-strong")}>
                    <RadioTower className="size-5" />
                  </div>
                  <div className="flex-1">
                    <p className="font-mono text-lg font-semibold">{s.link === "AOS" ? "Acquisition of signal" : "Loss of signal"}</p>
                    <p className="text-xs text-muted-foreground">last sync {fmtDate(s.last_synced_at)}</p>
                  </div>
                  <Switch checked={s.link === "AOS"} onCheckedChange={setLink} aria-label="Ground link" />
                </div>
                <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <span className="rounded bg-muted px-2 py-1">onboard outbox <b className="text-foreground">{s.pending}</b></span>
                  <span className="h-px flex-1 border-t border-dashed" />
                  <CloudUpload className={cn("size-4", s.link === "AOS" ? "text-success" : "text-muted-foreground")} />
                  <span className="h-px flex-1 border-t border-dashed" />
                  <span className="rounded bg-muted px-2 py-1">ground <b className="text-foreground">{s.ground_received}</b></span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <StatTile label="Pending events" value={s?.pending ?? "—"} icon={CloudUpload} tone={s?.pending ? "warn" : "ok"} hint="Replayed automatically every 5 s while AOS" />
      </div>

      <Card>
        <CardHeader><CardTitle>Adapters</CardTitle><CardDescription>Connected and pending device adapters.</CardDescription></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Device</TableHead><TableHead>Kind</TableHead><TableHead>Integration</TableHead><TableHead>Status</TableHead><TableHead>Note</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {devices.data?.map((d) => (
                <TableRow key={d.id}>
                  <TableCell><p className="font-medium">{d.name}</p><p className="font-mono text-[10px] text-muted-foreground">{d.id}</p></TableCell>
                  <TableCell className="text-xs">{humanize(d.kind)}</TableCell>
                  <TableCell><StatusBadge value={d.integration} /></TableCell>
                  <TableCell><StatusBadge value={d.status} dot /></TableCell>
                  <TableCell className="max-w-sm whitespace-normal text-xs text-muted-foreground">{d.note}</TableCell>
                  <TableCell className="text-right">
                    {d.integration === "SIMULATED" && d.status === "FAULT" && (
                      <Button size="sm" variant="outline" onClick={() => api(`/devices/${d.id}/reset`, { method: "POST" }).then(() => { toast.success(`${d.name} reset`); refresh(); })}><RotateCcw />Reset</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {user.role !== "ASTRONAUT" && <EvaPlanner crew={crew} />}
        {rad.data && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Radiation className="size-4 text-warning-strong" />Personal dosimetry · {crew}</CardTitle>
              <CardDescription>{rad.data.note}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {rad.data.readings.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Time</TableHead><TableHead className="text-right">Rate</TableHead><TableHead className="text-right">Cumulative</TableHead><TableHead>EVA</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {rad.data.readings.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{fmtDate(r.measured_at)}</TableCell>
                        <TableCell className="text-right font-mono">{r.dose_rate_uGy_h} µGy/h</TableCell>
                        <TableCell className="text-right font-mono">{r.cumulative_uGy} µGy</TableCell>
                        <TableCell className="font-mono text-xs">{r.eva_id ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <EmptyState icon={Radiation}>No dosimeter check readings yet</EmptyState>}
              {!!rad.data.eva.length && <p className="text-xs text-muted-foreground">Planned EVAs: {rad.data.eva.map((e) => `${e.id} (${fmtDate(e.planned_start)})`).join(", ")}</p>}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function EvaPlanner({ crew }: { crew: string }) {
  const { refresh } = useSession();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Rocket className="size-4 text-primary" />Plan EVA · {crew}</CardTitle>
        <CardDescription>Creates EVENT_TRIGGERED pre- and post-EVA dosimeter checks from the assigned protocols.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
          e.preventDefault();
          api<{ task_ids: string[] }>("/eva", { body: { crew_member_id: crew, planned_start: new Date(start + "Z").toISOString(), planned_end: new Date(end + "Z").toISOString() } })
            .then((r) => { toast.success(`EVA planned · ${r.task_ids.length} checks scheduled`); refresh(); }).catch((x) => toast.error(x.message));
        }}>
          <div className="grid gap-2"><Label htmlFor="eva-start">Start (UTC)</Label><Input id="eva-start" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="eva-end">End (UTC)</Label><Input id="eva-end" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          <div className="sm:col-span-2"><Button>Plan EVA</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
