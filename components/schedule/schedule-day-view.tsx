"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { Task } from "@/lib/api";
import { PageSkeleton } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScheduleCalendar } from "@/components/schedule/schedule-calendar";
import { ScheduleDayList } from "@/components/schedule/schedule-day-list";

export function ScheduleDayView({ tasks, today, ops, loading }: { tasks: Task[]; today: string; ops: boolean; loading: boolean }) {
  const [day, setDay] = useState(today);
  const visibleTasks = useMemo(
    () => tasks.filter((task) => task.due_at.slice(0, 10) === day).sort((a, b) => a.due_at.localeCompare(b.due_at)),
    [day, tasks],
  );

  if (loading) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <CalendarDays className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate">{formatDayHeading(day, today)}</span>
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => setDay((value) => shiftDay(value, -1))} aria-label="Previous day">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setDay((value) => shiftDay(value, 1))} aria-label="Next day">
              <ChevronRight />
            </Button>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,7fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Activities</CardTitle>
          </CardHeader>
          <CardContent><ScheduleDayList tasks={visibleTasks} ops={ops} /></CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Day calendar</CardTitle>
          </CardHeader>
          <CardContent><ScheduleCalendar tasks={visibleTasks} day={day} /></CardContent>
        </Card>
      </div>
    </div>
  );
}

function shiftDay(day: string, amount: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function formatDayHeading(day: string, today: string) {
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return day === today ? `Today · ${label}` : label;
}
