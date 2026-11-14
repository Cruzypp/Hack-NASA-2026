"use client";

import { ClipboardCheck, Cpu, HeartPulse } from "lucide-react";
import { useState } from "react";
import { type Alert, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { AlertCard } from "@/components/alert";
import { EmptyState, ErrorAlert, PageHeader, PageSkeleton } from "@/components/astra";
import { TaskRow } from "@/components/task";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function View() {
  const { user, crew } = useSession();
  const ops = user.role === "MISSION_OPERATOR";
  const alerts = useData<Alert[]>("/alerts");
  const tasks = useData<Task[]>(ops ? null : `/tasks?crew_member_id=${crew}`);
  const [showResolved, setShowResolved] = useState(false);
  if (!alerts.data) return alerts.error ? <ErrorAlert error={alerts.error} /> : <PageSkeleton />;

  const visible = alerts.data.filter((a) => showResolved || a.status !== "RESOLVED");
  const medical = visible.filter((a) => a.category === "MEDICAL");
  const operational = visible.filter((a) => a.category === "OPERATIONAL");
  const followUps = tasks.data?.filter((t) => t.source_alert_id) ?? [];
  const openFollowUps = followUps.filter((t) => t.status !== "COMPLETED").length;
  const count = (n: number) => <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 font-mono text-[10px]">{n}</Badge>;

  return (
    <>
      <PageHeader title="Alerts & follow-ups" description="Medical and operational alerts are always separate. Anomalies create a follow-up for medical review; they never change the clinical protocol.">
        <div className="flex items-center gap-2">
          <Switch id="resolved" checked={showResolved} onCheckedChange={setShowResolved} />
          <Label htmlFor="resolved" className="text-muted-foreground">Show resolved</Label>
        </div>
      </PageHeader>
      <Tabs defaultValue={ops ? "operational" : "medical"}>
        <TabsList>
          {!ops && <TabsTrigger value="medical"><HeartPulse />Medical{count(medical.length)}</TabsTrigger>}
          <TabsTrigger value="operational"><Cpu />Operational{count(operational.length)}</TabsTrigger>
          {!ops && <TabsTrigger value="followups"><ClipboardCheck />Follow-ups{count(openFollowUps)}</TabsTrigger>}
        </TabsList>
        {!ops && (
          <TabsContent value="medical" className="mt-4 grid gap-4 xl:grid-cols-2">
            {medical.length ? medical.map((a) => <AlertCard key={a.id} alert={a} />) : <Card className="xl:col-span-2"><CardContent><EmptyState icon={HeartPulse}>No medical alerts</EmptyState></CardContent></Card>}
          </TabsContent>
        )}
        <TabsContent value="operational" className="mt-4 grid gap-4 xl:grid-cols-2">
          {operational.length ? operational.map((a) => <AlertCard key={a.id} alert={a} />) : <Card className="xl:col-span-2"><CardContent><EmptyState icon={Cpu}>No operational alerts</EmptyState></CardContent></Card>}
        </TabsContent>
        {!ops && (
          <TabsContent value="followups" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Follow-up tasks · {crew}</CardTitle>
                <CardDescription>Created automatically from anomalies; completed only by an authorised verification.</CardDescription>
              </CardHeader>
              <CardContent>{followUps.length ? <ul className="-mx-2 flex flex-col">{followUps.map((t) => <TaskRow key={t.id} task={t} showDate />)}</ul> : <EmptyState icon={ClipboardCheck}>No follow-ups</EmptyState>}</CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
