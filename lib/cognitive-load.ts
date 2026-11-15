"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useData, useSession } from "./session";

// Contract: docs/FLIGHT_DATA_CONTRACT.md. The onboard node replays the processed
// LOFT window as a sensor session; the console never recomputes the statistics.
export type FlightSignal = "ECG" | "GSR" | "EEG_FP1" | "EEG_Cz";
export type FlightSample = {
  t: number; phase: string; cognitive_load: number; alerta_activa: boolean; z: Record<FlightSignal, number>;
};
export type CognitiveSummary = {
  samples: number; duration_s: number; peak_load: number | null; peak_t: number | null; peak_phase: string | null;
  peak_z: Record<FlightSignal, number> | null; mean_by_phase: Record<string, number>; alert_s: number; alert_id: string | null;
  rule: { id: string; version: string; threshold_z: number; provenance: string };
  source: { hz: number; window_s: number; rule: string; source: string; note: string };
};
export type CognitiveSession = {
  id: string; crew_member_id: string; status: "RUNNING" | "COMPLETED" | "FAULTED"; started_at: string; ended_at: string | null;
  summary: CognitiveSummary | null;
};
export type CognitiveOverview = {
  sessions: CognitiveSession[]; source_note: string; rule: CognitiveSummary["rule"];
  latest: (CognitiveSession & { trace: { at: string; cognitive_load: number; z: Record<FlightSignal, number> }[] }) | null;
};

/** Stored cognitive-load sessions for `crew`, plus the live stream while a playback runs. */
export function useCognitiveLoad(crew: string) {
  const { subscribe } = useSession();
  const overview = useData<CognitiveOverview>(`/cognitive/${crew}`);
  // Tagged with the crew it belongs to, so switching crew member never shows someone else's stream.
  const [stream, setStream] = useState<{ crew: string; samples: FlightSample[]; progress: { index: number; total: number } | null }>(
    { crew, samples: [], progress: null });

  useEffect(() => subscribe((e) => {
    if (e.crew_member_id !== crew) return;
    if (e.type === "cognitive_started") setStream({ crew, samples: [], progress: { index: 0, total: e.total as number } });
    if (e.type === "cognitive_sample") setStream((s) => ({
      crew, samples: [...(s.crew === crew ? s.samples : []), e as unknown as FlightSample].slice(-240),
      progress: { index: e.index as number, total: e.total as number },
    }));
    if (e.type === "cognitive_finished") setStream((s) => ({ ...s, progress: null }));
  }), [crew, subscribe]);

  const live = stream.crew === crew ? stream.samples : [];
  const progress = stream.crew === crew ? stream.progress : null;
  const running = !!progress || overview.data?.sessions[0]?.status === "RUNNING";
  const start = useCallback(() => api<CognitiveSession>("/cognitive/sessions", { body: { crew_member_id: crew } }), [crew]);
  return { overview: overview.data, error: overview.error, live, current: live.at(-1) ?? null, progress, running, start };
}
