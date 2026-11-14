import {
  BadgeCheck,
  BellRing,
  Check,
  ClipboardCheck,
  Dumbbell,
  Repeat2,
} from "lucide-react";

export type ProtocolCriterion = {
  text: React.ReactNode;
  complete?: boolean;
};

export type ProtocolCardProps = {
  title: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  schedule: {
    label?: string;
    value: React.ReactNode;
    description: string;
    reminder?: React.ReactNode;
  };
  completion: {
    label?: string;
    criteria: ProtocolCriterion[];
  };
  approval: {
    name: string;
    role: string;
    effective: string;
    detail: string;
  };
};

export function ProtocolCard({
  title,
  icon: Icon = Dumbbell,
  schedule,
  completion,
  approval,
}: ProtocolCardProps) {
  return (
    <article className="relative overflow-hidden rounded-[0.875rem] border border-[#D0E0EF] bg-white text-[#101D3B] shadow-[0_10px_30px_-5px_rgba(16,29,59,0.07),0_4px_12px_-2px_rgba(16,29,59,0.04)]">
      <header className="border-b border-[#D0E0EF] p-5 pb-4 md:p-6 md:pb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#D0E0EF] bg-[#E7F3F8] text-[#0C9DAA] shadow-sm">
              <Icon className="size-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight md:text-xl">{title}</h2>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 md:p-6">
        <ProtocolTile icon={Repeat2} label={schedule.label ?? "When"}>
          <p className="text-base font-bold tracking-wide">{schedule.value}</p>
          <p className="mt-0.5 text-xs text-[#52657B]">{schedule.description}</p>
          {schedule.reminder && (
            <div className="mt-4 flex items-start gap-2 border-t border-[#D0E0EF] pt-3 text-xs leading-relaxed text-[#52657B]">
              <BellRing className="mt-0.5 size-3.5 shrink-0 text-[#E5A044]" aria-hidden />
              <span>{schedule.reminder}</span>
            </div>
          )}
        </ProtocolTile>

        <ProtocolTile icon={ClipboardCheck} label={completion.label ?? "Done when"}>
          <ul className="space-y-2 text-xs">
            {completion.criteria.map((criterion, index) => (
              <li key={index} className={criterion.complete === false ? "flex items-start gap-2.5 text-[#52657B]" : "flex items-start gap-2.5 text-[#101D3B]"}>
                <span className={criterion.complete === false
                  ? "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-[#D0E0EF] bg-[#E2EBF4] text-[#52657B]"
                  : "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-[#16835D]/30 bg-[#E5F5EE] text-[#16835D]"}>
                  <Check className="size-2.5" strokeWidth={criterion.complete === false ? 2.5 : 3} aria-hidden />
                </span>
                <span>{criterion.text}</span>
              </li>
            ))}
          </ul>
        </ProtocolTile>
      </div>

      <footer className="border-t border-[#D0E0EF] bg-[#F9FCFE] p-5 md:p-6">
        <Metadata icon={BadgeCheck} label="Approved">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {approval.name}
            <span className="font-mono text-xs font-normal text-[#52657B]">· {approval.role}</span>
          </p>
          <p className="text-[11px] leading-relaxed text-[#52657B]">
            Effective <time className="font-medium text-[#101D3B]">{approval.effective}</time> · {approval.detail}
          </p>
        </Metadata>
      </footer>
    </article>
  );
}

function ProtocolTile({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[0.875rem] border border-[#D0E0EF] bg-[#F0F5FA] p-4 shadow-sm transition-colors hover:border-[#0C9DAA]/40">
      <div className="mb-2.5 flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wider text-[#52657B]">
        <Icon className="size-3.5 text-[#0C9DAA]" aria-hidden />
        <span>{label}</span>
      </div>
      {children}
    </section>
  );
}

function Metadata({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#52657B]">
        <Icon className="size-3.5 text-[#0C9DAA]" aria-hidden />
        <span>{label}</span>
      </p>
      {children}
    </div>
  );
}
