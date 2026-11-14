import { fmtDate, type Measurement } from "@/lib/api";
import { EmptyState, StatusBadge } from "@/components/astra";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { humanize, metricLabel } from "@/lib/labels";

export type Device = { id: string; name: string; kind: string; integration: string; status: string; note?: string; last_seen?: string | null };

export function DeviceList({ devices }: { devices: Device[] }) {
  return (
    <ul className="flex flex-col divide-y">
      {devices.map((d) => (
        <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
          <span className={cn("size-2 shrink-0 rounded-full",
            d.status === "ONLINE" ? "bg-success shadow-[0_0_8px] shadow-success" : d.status === "FAULT" ? "bg-destructive" : "bg-muted-foreground/40")} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
          <StatusBadge value={d.status} />
        </li>
      ))}
    </ul>
  );
}

export function MeasurementTable({ rows, actions }: { rows: Measurement[]; actions?: (m: Measurement) => React.ReactNode }) {
  if (!rows.length) return <EmptyState>No measurements</EmptyState>;
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>Time</TableHead><TableHead>Metric</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Source</TableHead><TableHead>Quality</TableHead>{actions && <TableHead />}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.id} className={cn(m.superseded && "text-muted-foreground")}>
            <TableCell className="font-mono text-xs">{fmtDate(m.measured_at)}</TableCell>
            <TableCell>{metricLabel(m.metric)}</TableCell>
            <TableCell className={cn("text-right font-mono tabular-nums", m.superseded && "line-through")}>{m.value} <span className="text-muted-foreground">{m.unit}</span></TableCell>
            <TableCell className="text-xs">
              {humanize(m.source)}
              {m.correction_reason && <span className="block text-warning-strong">corrected · {m.correction_reason}</span>}
              {m.superseded ? <span className="block">superseded</span> : null}
            </TableCell>
            <TableCell><StatusBadge value={m.quality} /></TableCell>
            {actions && <TableCell className="text-right">{actions(m)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
