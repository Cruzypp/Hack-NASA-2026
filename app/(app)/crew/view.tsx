"use client";

import { Activity, BookText, ClipboardList, ScanSearch } from "lucide-react";
import { isMedical } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PageHeader } from "@/components/astra";
import { CarePlan } from "@/components/crew/care-plan";
import { Logbook } from "@/components/crew/logbook";
import { Reviews } from "@/components/crew/reviews";
import { StatusPanel } from "@/components/crew/status-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function View() {
  const { user, crew } = useSession();
  if (!isMedical(user.role)) return <p className="text-sm text-muted-foreground">This workspace is for medical staff.</p>;
  return (
    <>
      <PageHeader title={`Crew health · ${crew}`}
        description="Status against the astronaut's own baseline, their individual care plan, automated reviews and the clinical logbook. Use the selector at the top to switch crew member." />
      <Tabs defaultValue="status">
        <TabsList>
          <TabsTrigger value="status"><Activity />Status</TabsTrigger>
          <TabsTrigger value="plan"><ClipboardList />Care plan</TabsTrigger>
          <TabsTrigger value="reviews"><ScanSearch />Reviews</TabsTrigger>
          <TabsTrigger value="logbook"><BookText />Logbook</TabsTrigger>
        </TabsList>
        <TabsContent value="status" className="mt-4"><StatusPanel crew={crew} /></TabsContent>
        <TabsContent value="plan" className="mt-4"><CarePlan crew={crew} /></TabsContent>
        <TabsContent value="reviews" className="mt-4"><Reviews crew={crew} /></TabsContent>
        <TabsContent value="logbook" className="mt-4"><Logbook crew={crew} /></TabsContent>
      </Tabs>
    </>
  );
}
