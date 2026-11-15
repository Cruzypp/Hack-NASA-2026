"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type FlightSignal = "ECG" | "GSR" | "EEG_FP1" | "EEG_Cz";
export type FlightPhase = "prelaunch" | "launch" | "orbit" | string;

export type FlightBaseline = Record<FlightSignal, { median: number; iqr: number }>;

export type FlightSample = {
  t: number;
  phase: FlightPhase;
  cognitive_load: number;
  alerta_activa: boolean;
  z: Record<FlightSignal, number>;
};

export type FlightData = {
  meta: {
    hz: number;
    window_s: number;
    baseline_event: number;
    rule: string;
    source: string;
  };
  baseline: FlightBaseline;
  samples: FlightSample[];
};

export type FlightPlayback = {
  data: FlightData | null;
  current: FlightSample | null;
  trace: FlightSample[];
  loading: boolean;
  running: boolean;
  error: string | null;
  start: () => void;
  reset: () => void;
};

function isFlightData(value: unknown): value is FlightData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<FlightData>;
  return Boolean(data.meta && data.baseline && Array.isArray(data.samples) && data.samples.length);
}

export function useFlightPlayback(jsonUrl: string): FlightPlayback {
  const [data, setData] = useState<FlightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missionTime, setMissionTime] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(jsonUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load flight playback (${response.status})`);
        const payload: unknown = await response.json();
        if (!isFlightData(payload)) throw new Error("Flight playback has an invalid data contract");
        return payload;
      })
      .then((payload) => {
        setData(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load flight playback");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [jsonUrl]);

  useEffect(() => {
    if (!running || !data) return;
    const timer = window.setInterval(() => {
      setMissionTime((time) => {
        const lastTime = data.samples.at(-1)?.t ?? 0;
        if (time >= lastTime) {
          setRunning(false);
          return time;
        }
        return Math.min(time + 1, lastTime);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [data, running]);

  const start = useCallback(() => {
    if (!data) return;
    setMissionTime((time) => (time >= (data.samples.at(-1)?.t ?? 0) ? 0 : time));
    setRunning(true);
  }, [data]);

  const reset = useCallback(() => {
    setRunning(false);
    setMissionTime(0);
  }, []);

  const trace = useMemo(
    () => data?.samples.filter((sample) => sample.t <= missionTime).slice(-36) ?? [],
    [data, missionTime],
  );
  const current = trace.at(-1) ?? data?.samples[0] ?? null;

  return { data, current, trace, loading, running, error, start, reset };
}
