const STATUS_STYLES: Record<string, string> = {
  COMPLETED: "border-success/35 bg-success/10",
  PENDING: "border-primary/35 bg-primary/10",
  RUNNING: "border-primary/45 bg-primary/15",
  ACKNOWLEDGED: "border-primary/30 bg-primary/5",
  OVERDUE: "border-warning/45 bg-warning/12",
  CANCELLED: "border-destructive/35 bg-destructive/10",
  FAILED: "border-destructive/35 bg-destructive/10",
  FAULTED: "border-destructive/35 bg-destructive/10",
};

export function taskStatusClass(status: string) {
  return STATUS_STYLES[status] ?? "border-border bg-muted/20";
}
