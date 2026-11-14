import { Activity, CalendarClock, Dumbbell, HeartPulse, Radio, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { EmptyState, StatusBadge } from "@/components/astra";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type ExerciseSession = {
  id: string;
  kind: string;
  device_id: string;
  task_id: string | null;
  task_title?: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: {
    sample_count: number;
    valid_minutes: number;
    valid_fraction: number;
    duration_minutes: number;
    hr_mean: number | null;
    hr_peak: number | null;
    scenario?: string;
  } | null;
};

export function ExerciseSessionList({ sessions, loading }: { sessions: ExerciseSession[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarClock className="size-4 text-primary" />Exercise history</CardTitle>
        <CardDescription>Session duration, heart-rate response, samples and the linked activity.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <div className="h-32 animate-pulse rounded-md bg-muted/40" /> : sessions.length === 0 ? <EmptyState icon={Dumbbell}>No exercise sessions recorded</EmptyState> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Exercise</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Heart rate</TableHead>
                <TableHead>Samples</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => <SessionRow key={session.id} session={session} />)}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({ session }: { session: ExerciseSession }) {
  const summary = session.summary;
  const title = session.task_title ?? (session.kind === "EXERCISE" ? "Additional exercise session" : session.kind);
  return (
    <TableRow>
      <TableCell>
        <p className="flex items-center gap-2 font-medium"><Activity className="size-3.5 text-primary" />{title}</p>
        {session.summary?.scenario && <p className="mt-0.5 text-[10px] text-muted-foreground">{formatScenario(session.summary.scenario)}</p>}
        {session.task_id && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">Linked task</p>}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatTimeRange(session.started_at, session.ended_at)}</TableCell>
      <TableCell><Metric icon={Timer} value={summary ? `${summary.duration_minutes.toFixed(1)} min` : "—"} /></TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5 font-mono text-xs tabular-nums">
          <Metric icon={HeartPulse} value={summary?.hr_mean == null ? "—" : `${summary.hr_mean} avg`} />
          <span className="pl-5 text-[10px] text-warning-strong">{summary?.hr_peak == null ? "—" : `Peak HR ${summary.hr_peak} bpm`}</span>
        </div>
      </TableCell>
      <TableCell><Metric icon={Activity} value={summary ? `${summary.sample_count}` : "—"} /></TableCell>
      <TableCell><Metric icon={Radio} value={session.device_id === "bio-monitor-sim" ? "Bio-Monitor" : session.device_id} /></TableCell>
      <TableCell><StatusBadge value={session.status} /></TableCell>
    </TableRow>
  );
}

function Metric({ icon: Icon, value }: { icon: LucideIcon; value: string }) {
  return <span className="flex items-center gap-1.5 whitespace-nowrap text-xs"><Icon className="size-3 text-muted-foreground" aria-hidden />{value}</span>;
}

const formatTimeRange = (start: string, end: string | null) => {
  const date = new Date(start).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date} · ${time(start)}–${end ? time(end) : "…"}Z`;
};

const formatScenario = (scenario: string) => scenario === "PEAKS" ? "Pronounced HR peaks" : scenario.replaceAll("_", " ").toLowerCase();
