import { CalendarDays, Clock } from "lucide-react";
import type { Task } from "@/lib/api";
import { EmptyState, TaskIcon } from "@/components/astra";
import { taskStatusClass } from "@/components/schedule/schedule-status";

const HOUR_HEIGHT = 64;
const START_HOUR = 5;
const END_HOUR = 24;
const EVENT_DURATION_MINUTES = 60;

export function ScheduleCalendar({ tasks, day }: { tasks: Task[]; day: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background/30">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
        <Clock className="size-3.5 text-primary" aria-hidden />
        <span>Mission time · UTC</span>
      </div>
      {tasks.length === 0 ? (
        <EmptyState icon={CalendarDays}>No scheduled activities for this day</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <div className="relative min-w-[520px]" style={{ height: `${(END_HOUR - START_HOUR) * HOUR_HEIGHT}px` }} aria-label={`Schedule for ${day}`}>
            <div className="absolute inset-x-0 top-0 grid grid-rows-24" aria-hidden>
              {Array.from({ length: END_HOUR - START_HOUR }, (_, index) => {
                const hour = START_HOUR + index;
                return (
                <div key={hour} className="relative border-b border-border/60" style={{ height: HOUR_HEIGHT }}>
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground">
                    {String(hour).padStart(2, "0")}:00
                  </span>
                </div>
                );
              })}
            </div>
            <div className="absolute inset-y-0 left-16 right-3 border-l border-border/60" aria-hidden />
            {layoutEvents(tasks).map((group, groupIndex) => {
              const groupTop = (Math.max(START_HOUR * 60, group.start) / 60 - START_HOUR) * HOUR_HEIGHT;
              const groupHeight = Math.max(HOUR_HEIGHT, (group.end - group.start) / 60 * HOUR_HEIGHT);
              return (
                <div key={`${group.start}-${groupIndex}`} className="absolute left-20 right-3" style={{ top: `${groupTop + 4}px`, height: `${groupHeight - 8}px` }}>
                  {group.events.map(({ task, start, column, columns }) => {
                    const time = new Date(task.due_at);
                    const offset = Math.max(0, start - group.start) / 60 * HOUR_HEIGHT;
                    return (
                      <div
                        key={task.id}
                        className={`absolute min-h-14 overflow-hidden rounded-md border px-3 py-2 shadow-sm ${taskStatusClass(task.status)}`}
                        style={{ top: `${offset}px`, left: `${(column / columns) * 100}%`, width: `${100 / columns}%` }}
                      >
                        <div className="flex items-start gap-2">
                          <TaskIcon type={task.task_type} category={task.category} className="mt-0.5 size-3.5 shrink-0 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{task.title}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {time.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}Z
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type PositionedEvent = { task: Task; start: number; column: number; columns: number };
type EventGroup = { start: number; end: number; events: PositionedEvent[] };

function layoutEvents(tasks: Task[]): EventGroup[] {
  const events = tasks
    .map((task) => {
      const date = new Date(task.due_at);
      return { task, start: date.getUTCHours() * 60 + date.getUTCMinutes() };
    })
    .sort((a, b) => a.start - b.start);
  const groups: { start: number; end: number; events: typeof events }[] = [];

  for (const event of events) {
    const end = event.start + EVENT_DURATION_MINUTES;
    const current = groups.at(-1);
    if (!current || event.start >= current.end) groups.push({ start: event.start, end, events: [event] });
    else {
      current.end = Math.max(current.end, end);
      current.events.push(event);
    }
  }

  return groups.map((group) => {
    const columnEnds: number[] = [];
    const positioned = group.events.map((event) => {
      let column = columnEnds.findIndex((end) => end <= event.start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(0);
      }
      columnEnds[column] = event.start + EVENT_DURATION_MINUTES;
      return { ...event, column, columns: 0 };
    });
    return { ...group, events: positioned.map((event) => ({ ...event, columns: columnEnds.length })) };
  });
}
