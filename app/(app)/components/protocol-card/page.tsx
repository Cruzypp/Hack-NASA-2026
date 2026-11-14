import { ProtocolCard } from "@/components/shared/protocol-card";

export default function ProtocolCardPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6 py-6">
      <div className="w-full max-w-[680px]">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Shared component preview</p>
        <ProtocolCard
          title="Aerobic exercise session"
          schedule={{
            value: <>Daily at <span className="font-mono font-semibold text-[#0C9DAA]">09:00Z</span></>,
            description: "Counted from Mission Day 1",
            reminder: <>Reminder <strong className="font-semibold text-[#101D3B]">30 min before</strong> · overdue after <strong className="font-semibold text-[#101D3B]">60 min</strong></>,
          }}
          completion={{
            criteria: [
              { text: <>At least <strong className="font-semibold">25 min</strong> of valid heart rate telemetry</> },
              { text: <>Signal quality <strong className="font-mono font-semibold">≥ 80%</strong></> },
              { complete: false, text: "Manual log accepted if the sensor is unavailable" },
            ],
          }}
          approval={{
            name: "Dr. S. Lindqvist",
            role: "flight surgeon",
            effective: "4 Oct 2026",
            detail: "Demo crew, ASTRA-DEMO Increment",
          }}
        />
      </div>
    </div>
  );
}
