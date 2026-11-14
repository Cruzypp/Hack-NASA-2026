"use client";

import { useState } from "react";
import { Radiation } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, isMedical, type RadiationBrief, type RadiationReading } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { EmptyState, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type Summary = RadiationBrief & { readings: RadiationReading[]; area_readings: RadiationReading[] };

const DEVICES = [
  { id: "passive-dosimeter", label: "Passive dosimeter readout" },
  { id: "cad-sim", label: "Crew Active Dosimeter display" },
  { id: "rem-sim", label: "Area monitor display" },
  { id: "manual", label: "Other / unspecified" },
];

/** Manual dose entry plus the recent dosimetry record for the crew member in view. */
export function RadiationPanel() {
  const { user, crew } = useSession();
  const canPersonal = user.crewMemberId === crew || isMedical(user.role);
  const summary = useData<Summary>(`/radiation/${crew}?days=7`);
  const latest = summary.data?.personal.latest;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <EntryForm className="lg:col-span-2" crew={crew} canPersonal={canPersonal} lastCumulative={latest?.cumulative_uGy ?? null} />
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Radiation className="size-4 text-warning-strong" />Personal dosimetry · {crew}</CardTitle>
          <CardDescription>
            Continuous dosimeter readings every 15 min plus manual entries. 7-day dose {summary.data?.personal.window_dose_uGy ?? "—"} µGy ·
            mean {summary.data?.personal.mean_rate_uGy_h ?? "—"} µGy/h.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!summary.data?.readings.length ? <EmptyState icon={Radiation}>No readings yet</EmptyState> : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Time</TableHead><TableHead className="text-right">Rate</TableHead><TableHead className="text-right">Cumulative</TableHead><TableHead>Source</TableHead><TableHead>EVA</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {summary.data.readings.slice(0, 12).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{fmtDate(r.measured_at)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{r.dose_rate_uGy_h} <span className="text-muted-foreground">µGy/h</span></TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{r.cumulative_uGy?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge value={r.source === "MANUAL" ? "Manual" : "Sensor"} tone={r.source === "MANUAL" ? "info" : "ok"} />
                      {r.note && <span className="ml-2 text-xs text-muted-foreground">{r.note}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.eva_id ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EntryForm({ crew, canPersonal, lastCumulative, className }: { crew: string; canPersonal: boolean; lastCumulative: number | null; className?: string }) {
  const { refresh } = useSession();
  const [scope, setScope] = useState<"PERSONAL" | "AREA">(canPersonal ? "PERSONAL" : "AREA");
  const [device, setDevice] = useState("passive-dosimeter");
  const [rate, setRate] = useState("");
  const [cumulative, setCumulative] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<RadiationReading>("/radiation/readings", { body: {
        scope, device_id: device, dose_rate_uGy_h: Number(rate), crew_member_id: scope === "PERSONAL" ? crew : null,
        cumulative_uGy: scope === "PERSONAL" && cumulative ? Number(cumulative) : null,
        measured_at: when ? new Date(when + "Z").toISOString() : null, note: note || null,
      } });
      toast.success("Radiation reading recorded", { description: r.eva_id ? `Linked to ${r.eva_id}` : `${r.scope.toLowerCase()} · ${r.dose_rate_uGy_h} µGy/h` });
      setRate(""); setCumulative(""); setNote(""); refresh();
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Log a dose reading</CardTitle>
        <CardDescription>For readouts the system cannot capture itself, e.g. a passive dosimeter or a display copied while its data link is down.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as "PERSONAL" | "AREA")}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {canPersonal && <SelectItem value="PERSONAL">Personal · {crew}</SelectItem>}
                  <SelectItem value="AREA">Area (environment)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Source device</Label>
              <Select value={device} onValueChange={setDevice}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{DEVICES.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="rad-rate">Dose rate (µGy/h)</Label>
              <Input id="rad-rate" type="number" step="any" min={0} required className="font-mono" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            {scope === "PERSONAL" && (
              <div className="grid gap-2">
                <Label htmlFor="rad-cum">Cumulative (µGy, optional)</Label>
                <Input id="rad-cum" type="number" step="any" min={lastCumulative ?? 0} className="font-mono" value={cumulative} onChange={(e) => setCumulative(e.target.value)}
                  placeholder={lastCumulative != null ? `≥ ${lastCumulative.toLocaleString()}` : undefined} />
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rad-when">Measured at (UTC, blank = now)</Label>
            <Input id="rad-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rad-note">Note (optional)</Label>
            <Textarea id="rad-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. readout after EVA, badge #2" />
          </div>
          <p className="text-[11px] text-muted-foreground">Personal readings taken during a planned EVA are linked to it automatically. Cumulative dose can never be lower than the previous reading.</p>
          <Button size="lg" disabled={busy}>{busy ? "Recording…" : "Record reading"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
