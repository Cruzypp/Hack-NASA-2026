"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { metricLabel } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function ScheduleOrderForm({ crew }: { crew: string }) {
  const { refresh } = useSession();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [metric, setMetric] = useState("verification");
  const [priority, setPriority] = useState("HIGH");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const measure = metric !== "verification";
      await api("/tasks", { body: {
        crew_member_id: crew, title, due_at: new Date(due + "Z").toISOString(), priority, note: note || null,
        task_type: measure ? "MEASUREMENT" : "VERIFICATION",
        completion_rule: measure ? { kind: "MEASUREMENT", metric, allow_manual: true } : { kind: "VERIFICATION", roles: ["CREW_MEDICAL_OFFICER", "FLIGHT_SURGEON"] },
      } });
      toast.success("Task ordered", { description: `${title} for ${crew}` });
      setTitle(""); setNote(""); refresh();
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader><CardTitle>Clinician-ordered task · {crew}</CardTitle><CardDescription>Adds a one-off task. It does not modify any protocol version.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="o-title">Title</Label><Input id="o-title" required minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Repeat blood pressure at rest" /></div>
          <div className="grid gap-2"><Label htmlFor="o-due">Due (UTC)</Label><Input id="o-due" type="datetime-local" required value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div className="grid gap-2"><Label>Priority</Label><Select value={priority} onValueChange={setPriority}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["ROUTINE", "HIGH", "CRITICAL"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select></div>
          <div className="grid gap-2 sm:col-span-2"><Label>Completion</Label><Select value={metric} onValueChange={setMetric}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="verification">Verification by CMO / flight surgeon</SelectItem>{["resting_hr", "systolic_bp", "diastolic_bp", "body_temp", "body_mass"].map((m) => <SelectItem key={m} value={m}>Measurement · {metricLabel(m)}</SelectItem>)}</SelectContent></Select></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="o-note">Instructions (optional)</Label><Textarea id="o-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="sm:col-span-2"><Button disabled={busy}>{busy ? "Ordering…" : "Order task"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
