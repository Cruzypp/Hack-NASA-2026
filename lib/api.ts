export const API = process.env.NEXT_PUBLIC_ASTRA_API ?? "http://localhost:8000";

export type User = { id: string; role: Role; crewMemberId: string | null; name: string };
export type Role = "ASTRONAUT" | "CREW_MEDICAL_OFFICER" | "FLIGHT_SURGEON" | "MISSION_OPERATOR";

export type Evidence = { id: string; kind: string; ref_id: string; accepted: number; reasons: string[]; created_at: string };
export type Task = {
  id: string; crew_member_id: string; protocol_id: string | null; protocol_version_id: string | null;
  title: string; task_type: string; category: string; schedule_type: string; due_at: string;
  priority: "ROUTINE" | "HIGH" | "CRITICAL"; assigned_by: string; status: string; completed_at: string | null;
  escalated: number; source_alert_id: string | null; note: string | null;
  completionCriteria: Record<string, unknown> & { kind: string; metric?: string };
  evidence: Evidence[]; evidenceIds: string[]; manualAllowed: boolean;
};
export type Measurement = {
  id: string; metric: string; value: number; unit: string; measured_at: string; source: string;
  quality: string; superseded: number; supersedes_id: string | null; correction_reason: string | null; entered_by: string;
};
export type ContextFactor = { factor: string; detail: string; effect: string };
export type Alert = {
  id: string; crew_member_id: string | null; category: "MEDICAL" | "OPERATIONAL"; type: string; severity: string;
  title: string; status: string; created_at: string; rule_id: string | null; rule_version: string | null;
  resolved_by: string | null; resolution_note: string | null; follow_up_task_id: string | null;
  explanation: Record<string, unknown> & {
    summary?: string; context?: ContextFactor[]; recommendation?: string; z?: number;
    baseline?: { n: number; median: number; robust_sd: number };
    advisory_model?: { name: string; version: string; status: string; score?: number; outlier?: boolean; note: string };
    rule?: { provenance?: string };
    findings?: { code: string; level: string; title: string; observation: string; action: string; responsible: string }[];
  };
};
export type RadiationReading = {
  id: string; crew_member_id: string | null; device_id: string; scope: "PERSONAL" | "AREA"; dose_rate_uGy_h: number;
  cumulative_uGy: number | null; measured_at: string; eva_id: string | null; source: "SENSOR" | "MANUAL";
  entered_by: string | null; note: string | null;
};
export type RadiationBrief = {
  window_days: number; limits: string;
  personal: { latest: RadiationReading | null; mean_rate_uGy_h: number | null; window_dose_uGy: number | null; series: { value: number; measured_at: string }[] };
  area: { latest: RadiationReading | null; mean_rate_uGy_h: number | null; series?: { value: number; measured_at: string }[] };
};
export type SyncState = { link: "AOS" | "LOS"; pending: number; last_synced_at: string | null; ground_received: number };

const TOKEN = "astra.token";

export const session = {
  token: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN)),
  set: (t: string) => localStorage.setItem(TOKEN, t),
  clear: () => localStorage.removeItem(TOKEN),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(API + path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token() ?? ""}` },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail ?? res.statusText));
  }
  return data as T;
}

// Mission time is UTC, 24 h.
export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";
export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";
export const isMedical = (r?: Role) => r === "CREW_MEDICAL_OFFICER" || r === "FLIGHT_SURGEON";

export type LogEntry = {
  id: string; crew_member_id: string; author_id: string; author_role: string; author_name: string;
  category: "OBSERVATION" | "CONSULTATION" | "PLAN_CHANGE" | "COMMUNICATION" | "AUTOMATED" | "OTHER";
  body: string; linked_type: string | null; linked_id: string | null; shared_with_crew: number; amends_id: string | null;
  created_at: string; addenda?: LogEntry[];
};
export type ReviewReport = {
  id: string; crew_member_id: string; task_id: string | null; metric: string; window_from: string; window_to: string; created_at: string;
  result: {
    status: "FINDINGS" | "WITHIN_BASELINE" | "INSUFFICIENT_DATA" | "INSUFFICIENT_BASELINE"; label: string; unit: string; window_days: number;
    n: number; mean?: number; baseline: { sufficient: boolean; median?: number; robust_sd?: number; n: number };
    deviations: { id: string; value: number; measured_at: string; z: number }[]; missing_days: string[];
    shift: { sd: number; flagged: boolean } | null; alert_id?: string; rule: { id: string; version: string; provenance: string };
  };
};
export type PlanItem = {
  id: string; protocol_id: string; version: string; name: string; task_type: string; category: string; schedule_type: string;
  schedule: Record<string, unknown>; completion_rule: Record<string, unknown> & { kind: string }; reminder: Record<string, unknown>;
  priority: string; source: string; source_kind: string; population: string; approved_by: string; approved_by_name?: string;
  approved_by_role?: string; effective_from: string; supersedes_id: string | null; change_reason: string | null;
  assigned_at: string; ended_at: string | null; end_reason: string | null;
};

export type BodyLevel = "WITHIN_REFERENCE" | "WATCH" | "REVIEW" | "ACTION";
export type BodyFinding = {
  code: string; level: BodyLevel; title: string; observation: string; interpretation: string; limitations: string;
  action: string; responsible: string; follow_up: "OPEN" | "MONITOR"; evidence: { date: string; reference: string };
};
export type BodyValues = {
  body_mass_kg: number; lean_mass_kg: number; skeletal_muscle_kg: number; fat_mass_kg: number; body_fat_pct: number;
  tbw_l: number; ecw_ratio: number; phase_angle_deg: number; visceral_fat_level: number; bmr_kcal: number;
};
export type BodyAssessment = {
  id: string; crew_member_id: string; measured_at: string; phase: "PREFLIGHT" | "INFLIGHT" | "POSTFLIGHT";
  mission_day: number | null; method: "BIA" | "DXA" | "MRI" | "OTHER"; device: string; quality: string; source: string;
  scenario: string | null; alert_id: string | null; entered_by: string; values: BodyValues; segments: Record<string, number>;
  conditions: Record<string, string | number | boolean>; method_info: { label: string; uncertainty: Record<string, number>; limitations: string[] };
  evaluation: {
    status: BodyLevel | "REFERENCE" | "NO_REFERENCE"; summary: string; findings: BodyFinding[]; limitations: string[];
    uncertainty: Record<string, number>; reference?: { method: string; n: number; from: string; to: string; ids: string[] };
    deltas: Record<string, { value: number; reference: number; pct?: number; diff?: number }>;
    segments: Record<string, { value: number; reference: number; pct: number; level: BodyLevel }>;
    leg_asymmetry_pct?: { value: number; reference: number };
    context?: { window_days: number; exercise_adherence: number | null; exercise_done: number; exercise_scheduled: number;
      telemetry_minutes: number; telemetry_sessions: number; sleep_mean_h: number | null; sleep_n: number; rpe_mean: number | null; nutrition: string };
  };
};
export type BodyComposition = {
  assessments: BodyAssessment[]; latest: BodyAssessment | null; segments: Record<string, string>;
  reference: { n: number; from: string; to: string; values: BodyValues; segments: Record<string, number> } | null;
  rule: { id: string; version: string; provenance: string; segment_pct: Record<string, number>; ecw_ratio_max: number };
  scenarios: Record<string, string>;
};
