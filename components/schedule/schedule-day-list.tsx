import { CalendarDays } from "lucide-react";
import type { Task } from "@/lib/api";
import { EmptyState, TaskIcon } from "@/components/astra";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { TaskRow } from "@/components/task";
import { taskStatusClass } from "@/components/schedule/schedule-status";

export function ScheduleDayList({ tasks, ops }: { tasks: Task[]; ops: boolean }) {
  if (!tasks.length) return <EmptyState icon={CalendarDays}>No activities for this day</EmptyState>;

  if (!ops) {
    return <ul className="-mx-2 flex flex-col">{tasks.map((task) => <TaskRow key={task.id} task={task} hideStatus hideTechnical hideNote hideEvidence className={`mb-3 border ${taskStatusClass(task.status)} last:mb-0`} />)}</ul>;
  }

  return (
    <Table>
      <TableBody>
        {tasks.map((task) => (
          <TableRow key={task.id} className={taskStatusClass(task.status)}>
            <TableCell className="w-20 font-mono text-xs">{formatTaskTime(task.due_at)}</TableCell>
            <TableCell>
              <span className="flex min-w-0 items-center gap-2">
                <TaskIcon type={task.task_type} category={task.category} className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{task.title}</span>
              </span>
            </TableCell>
            <TableCell className="font-mono text-xs">{task.crew_member_id}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const formatTaskTime = (iso: string) => `${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}Z`;
