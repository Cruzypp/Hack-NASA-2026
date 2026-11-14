// Plain-language descriptions of protocol schedules and completion rules.

type Json = Record<string, unknown>;

import { humanize, metricLabel, roleTitle } from "./labels";

const at = (t: unknown) => `${t}Z`;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Daily at 09:00Z", "Every 14 mission days from MD 14", "60 min before EVA start". */
export function describeSchedule(type: string, s: Json): { when: string; detail?: string } {
  if (type === "RECURRENT" && Array.isArray(s.weekdays)) {
    const days = (s.weekdays as number[]).map((d) => WEEKDAYS[d - 1]);
    const times = (s.at as string[]).map(at).join(", ");
    return { when: `${days.length === 7 ? "Daily" : `Every ${days.join(", ")}`} at ${times}`, detail: "Repeats every week" };
  }
  if (type === "RECURRENT") {
    const n = Number(s.every_days);
    const times = (s.at as string[]).map(at).join(", ");
    return { when: `${n === 1 ? "Daily" : n === 7 ? "Weekly" : `Every ${n} days`} at ${times}`, detail: "Counted from Mission Day 1" };
  }
  if (type === "MISSION_RELATIVE") {
    const days = s.mission_days as number[];
    const step = days[1] - days[0];
    const regular = days.length > 2 && days.every((d, i) => i === 0 || d - days[i - 1] === step);
    return regular
      ? { when: `Every ${step} mission days at ${at(s.at)}`, detail: `MD ${days[0]}, ${days[1]}, ${days[2]} … ${days.at(-1)} (${days.length} occurrences)` }
      : { when: `Mission days ${days.map((d) => `MD ${d}`).join(", ")} at ${at(s.at)}` };
  }
  if (type === "EVENT_TRIGGERED") {
    const m = Number(s.offset_min);
    return { when: `${Math.abs(m)} min ${m < 0 ? "before" : "after"} ${s.event} ${s.anchor}`, detail: `Created when an ${s.event} is planned` };
  }
  return { when: "Ordered by a clinician" };
}

/** Completion rule as a checklist. `optional` marks allowances rather than requirements. */
export function describeRule(r: Json): { text: string; optional?: boolean }[] {
  switch (r.kind) {
    case "TELEMETRY_SESSION":
      return [
        { text: `At least ${r.min_valid_minutes} min of valid ${metricLabel(String(r.metric)).toLowerCase()} telemetry` },
        { text: `Signal quality ≥ ${Math.round(Number(r.min_valid_fraction) * 100)}%` },
        r.manual_fallback ? { text: "Manual log accepted if the sensor is unavailable", optional: true } : { text: "Telemetry required (no manual log)" },
      ];
    case "MEASUREMENT":
      return [
        r.auto_capture
          ? { text: `${metricLabel(String(r.metric))} captured automatically by the sensor` }
          : { text: `${metricLabel(String(r.metric))} recorded` },
        r.allow_manual ? { text: r.auto_capture ? "Manual entry if the sensor is unavailable" : "Manual entry allowed", optional: true } : { text: "Sensor value required" },
        { text: "Invalid-quality data is rejected" },
      ];
    case "RADIATION_READING":
      return [{ text: "Personal dose reading recorded" }, r.manual_only ? { text: "Manual dosimeter readout required" } : { text: "Sensor or manual reading accepted", optional: true }];
    case "ACTIVITY":
      return [
        { text: "Crew member marks it done" },
        Number(r.min_minutes) > 0 ? { text: `At least ${r.min_minutes} min` } : { text: "Any duration", optional: true },
      ];
    case "AUTOMATED_REVIEW":
      return [
        { text: `Automatic search for ${metricLabel(String(r.metric)).toLowerCase()} deviations over the last ${r.window_days} days` },
        { text: "Findings raise an alert and a CMO review", optional: true },
      ];
    case "VERIFICATION":
      return [{ text: `Signed by ${(r.roles as string[]).map(roleTitle).join(" or ")}` }, { text: "Verification note required" }];
    case "DEVICE_CHECK":
      return [{ text: `${humanize(String(r.device_kind))} online` }, { text: `Reading within the last ${r.max_reading_age_min} min` }];
    default:
      return [{ text: JSON.stringify(r) }];
  }
}

export function describeReminder(r: Json, priority: string): string {
  return `Reminder ${r.lead_min} min before · overdue after ${r.overdue_after_min} min` +
    (priority === "CRITICAL" ? ` · escalates after ${r.escalate_after_min} min` : "");
}

/** Splits the seeded source text into the shared placeholder notice and the per-protocol reference. */
export function splitSource(source: string): { notice: string; reference: string } {
  const [notice, reference = ""] = source.split(" Context: ");
  return { notice: notice.trim(), reference: reference.trim() };
}
