"use client";

import { useSession } from "@/lib/session";
import { PageHeader } from "@/components/astra";
import { BodyCompositionPanel } from "@/components/body/body-composition";

export function View() {
  const { user, crew } = useSession();
  if (user.role === "MISSION_OPERATOR") return <p className="text-sm text-muted-foreground">Body composition is health data and is not shown to mission operations.</p>;
  return (
    <>
      <PageHeader title={`Body composition & segmental lean mass · ${crew}`}
        description="InBody-type segmental bioimpedance compared with the crew member's own preflight reference. Findings above the review threshold raise a medical alert and a CMO review task; no prescription changes automatically." />
      <BodyCompositionPanel crew={crew} />
    </>
  );
}
