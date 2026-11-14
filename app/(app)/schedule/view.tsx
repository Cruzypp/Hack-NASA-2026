"use client";

import { BookOpenCheck, CalendarClock, FilePlus2 } from "lucide-react";
import { isMedical, type Task } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { ErrorAlert, PageHeader } from "@/components/astra";
import { ScheduleDayView } from "@/components/schedule/schedule-day-view";
import { ScheduleOrderForm } from "@/components/schedule/schedule-order-form";
import { ScheduleProtocolCard, type Protocol } from "@/components/schedule/schedule-protocol-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function View() {
  const { user, crew } = useSession();
  const ops = user.role === "MISSION_OPERATOR";
  const tasks = useData<Task[]>(ops ? "/tasks" : `/tasks?crew_member_id=${crew}`);
  const protocols = useData<Protocol[]>("/protocols");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title="Health schedule" description="Recurrent, mission-relative, event-triggered and clinician-ordered tasks. Every frequency traces to an approved protocol version." />
      <ErrorAlert error={tasks.error} />
      <Tabs defaultValue="plan">
        <TabsList>
          <TabsTrigger value="plan"><CalendarClock />Plan</TabsTrigger>
          <TabsTrigger value="protocols"><BookOpenCheck />Protocols</TabsTrigger>
          {isMedical(user.role) && <TabsTrigger value="order"><FilePlus2 />Order task</TabsTrigger>}
        </TabsList>

        <TabsContent value="plan" className="mt-4">
          <ScheduleDayView tasks={tasks.data ?? []} today={today} ops={ops} loading={!tasks.data} />
        </TabsContent>

        <TabsContent value="protocols" className="mt-4 flex flex-col gap-4">
          {!protocols.data ? <div className="h-72 animate-pulse rounded-lg bg-muted/40" /> : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                {protocols.data.map((p) => <ScheduleProtocolCard key={p.id} p={p} />)}
              </div>
            </>
          )}
        </TabsContent>
        {isMedical(user.role) && <TabsContent value="order" className="mt-4"><ScheduleOrderForm crew={crew} /></TabsContent>}
      </Tabs>
    </>
  );
}
