"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { fmtDate } from "@/lib/api";
import { useData } from "@/lib/session";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge, TrendChart } from "@/components/astra";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Point = { id: string; value: number; unit: string; measured_at: string; source: string; sample_name: string | null;
  reference_range: { min: number; max: number } | null; in_range: boolean | null };
type Marker = { metric: string; panel: "CBC" | "CMP"; label: string; unit: string; series: Point[]; latest: Point | null; status: string;
  z?: number; baseline?: { sufficient: boolean; median?: number; robust_sd?: number; n: number } };
type Labs = { markers: Record<string, Marker>; note: string };

/** OSD CBC/CMP results: lab reference range and personal-baseline status per marker. */
export function LabsPanel({ crew }: { crew: string }) {
  const { data, error } = useData<Labs>(`/labs/${crew}`);
  const [selected, setSelected] = useState<string | null>(null);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  const markers = Object.values(data.markers);
  const withData = markers.filter((m) => m.latest);
  const m = data.markers[selected ?? ""] ?? withData[0];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FlaskConical className="size-4 text-primary" />Laboratory · CBC / CMP · {crew}</CardTitle>
          <CardDescription>{data.note}</CardDescription>
        </CardHeader>
        <CardContent>
          {!withData.length ? (
            <EmptyState icon={FlaskConical}>
              No laboratory results imported for {crew}.<br />
              <span className="font-mono text-xs">python scripts/procesar_osd.py --input path/to/OSD --db backend/astra.db</span>
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Panel</TableHead><TableHead>Marker</TableHead><TableHead className="text-right">Latest</TableHead><TableHead>Lab range</TableHead><TableHead>Range</TableHead><TableHead>Personal baseline</TableHead><TableHead className="text-right">Results</TableHead><TableHead>Date</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {markers.map((x) => (
                  <TableRow key={x.metric} onClick={() => x.latest && setSelected(x.metric)} className={cn(x.latest && "cursor-pointer", m?.metric === x.metric && "bg-muted/60")}>
                    <TableCell className="font-mono text-xs">{x.panel}</TableCell>
                    <TableCell>{x.label.replace(/^(CBC|CMP)\s/, "")}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{x.latest ? <>{x.latest.value} <span className="text-muted-foreground">{x.unit}</span></> : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{x.latest?.reference_range ? `${x.latest.reference_range.min}–${x.latest.reference_range.max}` : "—"}</TableCell>
                    <TableCell>{x.latest?.in_range == null ? "—" : <StatusBadge value={x.latest.in_range ? "IN RANGE" : "OUT OF RANGE"} tone={x.latest.in_range ? "ok" : "warn"} />}</TableCell>
                    <TableCell><StatusBadge value={x.status} />{x.z !== undefined && <span className="ml-2 font-mono text-xs">z {x.z}</span>}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{x.series.length}</TableCell>
                    <TableCell className="font-mono text-xs">{x.latest ? fmtDate(x.latest.measured_at) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {m?.latest && (
        <Card>
          <CardHeader>
            <CardTitle>{m.label} · trend</CardTitle>
            <CardDescription>
              {m.baseline?.sufficient ? `Band: personal baseline ${m.baseline.median} ± 2×${m.baseline.robust_sd} ${m.unit}` : `Personal baseline not established (n=${m.baseline?.n ?? 0}).`}
              {m.latest.sample_name && <> Last sample <span className="font-mono">{m.latest.sample_name}</span>.</>}
            </CardDescription>
          </CardHeader>
          <CardContent><TrendChart points={m.series} baseline={m.baseline ?? { sufficient: false }} unit={m.unit} label={m.metric} /></CardContent>
        </Card>
      )}
    </div>
  );
}
