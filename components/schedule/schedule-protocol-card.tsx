import { ClipboardCheck, Dumbbell, HeartPulse, Moon, Radiation, Stethoscope } from "lucide-react";
import { describeReminder, describeRule, describeSchedule } from "@/lib/protocol";
import { roleLabel } from "@/lib/labels";
import { ProtocolCard } from "@/components/shared/protocol-card";

export type Protocol = {
  id: string; name: string; version: string; schedule_type: string; schedule: Record<string, unknown>; task_type: string;
  completion_rule: Record<string, unknown>; priority: string; source: string; source_kind: string;
  population: string; approved_by: string; effective_from: string; category: string;
  reminder: Record<string, unknown>; approved_by_name?: string; approved_by_role?: string;
};

const ICONS = { EXERCISE: Dumbbell, MEASUREMENT: HeartPulse, DEVICE_CHECK: Radiation, EVALUATION: Stethoscope, VERIFICATION: ClipboardCheck };

/** Maps a protocol version from the API onto the shared ProtocolCard. */
export function ScheduleProtocolCard({ p }: { p: Protocol }) {
  const when = describeSchedule(p.schedule_type, p.schedule);
  return (
    <ProtocolCard
      title={p.name}
      icon={p.category === "SLEEP" ? Moon : ICONS[p.task_type as keyof typeof ICONS]}
      schedule={{ value: when.when, description: when.detail ?? "", reminder: describeReminder(p.reminder, p.priority) }}
      // Allowances (e.g. "Manual entry allowed") render as secondary items, requirements as checked.
      completion={{ criteria: describeRule(p.completion_rule).map((c) => ({ text: c.text, complete: !c.optional })) }}
      approval={{
        name: p.approved_by_name ?? p.approved_by,
        role: p.approved_by_role ? roleLabel(p.approved_by_role) : "approver",
        effective: fmtDay(p.effective_from),
        detail: p.source_kind === "CLINICAL_DECISION" ? p.population : "All crew",
      }}
    />
  );
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
