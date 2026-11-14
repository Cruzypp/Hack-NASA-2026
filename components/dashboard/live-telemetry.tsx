"use client";

import { useEffect, useState } from "react";
import { Activity, Radio, Radiation } from "lucide-react";
import { useSession } from "@/lib/session";
import { EmptyState } from "@/components/astra";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { time: string; value: number };
type HistoricalPoint = { measured_at: string; value: number };

/** Seeded from stored history; mount with `key={crew}` so switching crew member starts fresh. */
export function LiveTelemetry({ crew, initialPersonal, initialArea = [], initialSleep = [] }: {
  crew: string; initialPersonal: HistoricalPoint[]; initialArea?: HistoricalPoint[]; initialSleep?: HistoricalPoint[];
}) {
  const { subscribe } = useSession();
  const [heartRate, setHeartRate] = useState<Point[]>([]);
  const [personal, setPersonal] = useState<Point[]>(initialPersonal.slice(-24).map((point) => ({
    time: point.measured_at.slice(11, 16), value: point.value,
  })));
  const [area, setArea] = useState<Point[]>(initialArea.slice(-24).map((point) => ({
    time: point.measured_at.slice(11, 16), value: point.value,
  })));
  const [sleep, setSleep] = useState<Point[]>(initialSleep.slice(-24).map((point) => ({
    time: point.measured_at.slice(5, 10), value: point.value,
  })));

  useEffect(() => subscribe((event) => {
    if (event.crew_member_id && event.crew_member_id !== crew && event.type !== "radiation") return;
    if (event.type === "sample" && typeof event.value === "number") {
      setHeartRate((points) => [...points, { time: `${Number(event.offset_s ?? 0) / 60}′`, value: event.value as number }].slice(-36));
    }
    if (event.type === "radiation") {
      const reading = event.reading as { scope?: string; crew_member_id?: string | null; dose_rate_uGy_h?: number; measured_at?: string };
      if (typeof reading?.dose_rate_uGy_h !== "number") return;
      if (reading.scope === "PERSONAL" && reading.crew_member_id !== crew) return;
      const point = { time: reading.measured_at?.slice(11, 16) ?? "now", value: reading.dose_rate_uGy_h };
      if (reading.scope === "PERSONAL") setPersonal((points) => [...points, point].slice(-36));
      if (reading.scope === "AREA") setArea((points) => [...points, point].slice(-36));
    }
    if (event.type === "simulation" && event.kind === "sleep") {
      const measurement = event.measurement as { value?: number; measured_at?: string; crew_member_id?: string };
      if (typeof measurement?.value === "number" && measurement.crew_member_id === crew) {
        const value = measurement.value;
        setSleep((points) => [...points, { time: measurement.measured_at?.slice(5, 10) ?? "today", value }].slice(-36));
      }
    }
  }), [subscribe, crew]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Radio className="size-4 text-primary" />Live telemetry</CardTitle>
        <CardDescription>Live stream from onboard adapters.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-4">
        <TelemetryChart icon={Activity} title="Heart rate" unit="bpm" color="var(--primary)" points={heartRate} empty="Start an exercise simulation to stream HR." />
        <TelemetryChart icon={Activity} title="Sleep duration" unit="h" color="var(--chart-3)" points={sleep} empty="Run a sleep simulation to add a sleep result." />
        <TelemetryChart icon={Radiation} title="Personal dose rate" unit="µGy/h" color="var(--warning)" points={personal} empty="No personal radiation stream yet." />
        <TelemetryChart icon={Radiation} title="Area dose rate" unit="µGy/h" color="var(--chart-4)" points={area} empty="No area monitor readings yet." />
      </CardContent>
    </Card>
  );
}

function TelemetryChart({ icon: Icon, title, unit, color, points, empty }: { icon: typeof Activity; title: string; unit: string; color: string; points: Point[]; empty: string }) {
  const latest = points.at(-1)?.value;
  return (
    <div className="min-w-0 rounded-lg border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium"><Icon className="size-3.5 text-primary" />{title}</p>
        {latest !== undefined && <p className="font-mono text-sm tabular-nums">{latest} <span className="text-[10px] text-muted-foreground">{unit}</span></p>}
      </div>
      {points.length < 2 ? <EmptyState>{empty}</EmptyState> : (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={points} margin={{ left: -20, right: 4, top: 12, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="time" hide />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }} formatter={(value) => [`${value} ${unit}`, title]} />
            <Line dataKey="value" type="monotone" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
