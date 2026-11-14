"use client";

import { useState } from "react";
import { BookText, Bot, CornerDownRight, Eye, Lock } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, type LogEntry } from "@/lib/api";
import { useData, useSession } from "@/lib/session";
import { humanize, roleLabel } from "@/lib/labels";
import { EmptyState, ErrorAlert, PageSkeleton, StatusBadge } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const CATEGORIES = ["OBSERVATION", "CONSULTATION", "COMMUNICATION", "PLAN_CHANGE", "OTHER"] as const;
const FILTERS = ["ALL", "OBSERVATION", "CONSULTATION", "COMMUNICATION", "PLAN_CHANGE", "AUTOMATED"] as const;

export function Logbook({ crew }: { crew: string }) {
  const { data, error } = useData<LogEntry[]>(`/crew/${crew}/logbook`);
  const [filter, setFilter] = useState<string>("ALL");
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <PageSkeleton />;
  const entries = data.filter((e) => filter === "ALL" || e.category === filter);

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Composer crew={crew} className="lg:col-span-2" />
      <div className="flex flex-col gap-3 lg:col-span-3">
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList className="flex-wrap">{FILTERS.map((f) => <TabsTrigger key={f} value={f}>{f === "ALL" ? "All" : humanize(f)}</TabsTrigger>)}</TabsList>
        </Tabs>
        {!entries.length ? <Card><CardContent><EmptyState icon={BookText}>No entries</EmptyState></CardContent></Card>
          : <ol className="flex flex-col gap-3">{entries.map((e) => <Entry key={e.id} e={e} />)}</ol>}
      </div>
    </div>
  );
}

function Composer({ crew, className }: { crew: string; className?: string }) {
  const { refresh } = useSession();
  const [category, setCategory] = useState<string>("OBSERVATION");
  const [body, setBody] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/crew/${crew}/logbook`, { body: { category, body, shared_with_crew: shared } });
      toast.success("Logbook entry saved");
      setBody(""); setShared(false); refresh();
    } catch (x) { toast.error((x as Error).message); }
    setBusy(false);
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>New entry · {crew}</CardTitle>
        <CardDescription>Entries cannot be edited or deleted. Add an addendum to correct or follow up.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="log-body">Note</Label>
            <Textarea id="log-body" rows={6} required minLength={3} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="What was observed or discussed, assessment, and the agreed next step." />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="log-shared" checked={shared} onCheckedChange={setShared} />
            <Label htmlFor="log-shared" className="text-muted-foreground">Share with the crew member</Label>
          </div>
          <Button disabled={busy}>{busy ? "Saving…" : "Add to logbook"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Entry({ e }: { e: LogEntry }) {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const auto = e.category === "AUTOMATED";

  async function addendum(ev: React.FormEvent) {
    ev.preventDefault();
    try {
      await api(`/logbook/${e.id}/addendum`, { body: { body: text } });
      toast.success("Addendum added"); setText(""); setOpen(false); refresh();
    } catch (x) { toast.error((x as Error).message); }
  }

  return (
    <li>
      <Card size="sm" className={cn(auto && "bg-muted/40", e.category === "PLAN_CHANGE" && "ring-primary/30")}>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {auto ? <Bot className="size-3.5 text-muted-foreground" aria-hidden /> : null}
            <span className="font-medium">{e.author_name}</span>
            <span className="text-muted-foreground">{roleLabel(e.author_role)}</span>
            <span className="font-mono text-muted-foreground">{fmtDate(e.created_at)}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <StatusBadge value={e.category} tone={auto ? "neutral" : "info"} />
              {e.shared_with_crew ? <span className="flex items-center gap-1 text-success" title="Visible to the crew member"><Eye className="size-3.5" />Shared</span>
                : <span className="flex items-center gap-1 text-muted-foreground" title="Medical staff only"><Lock className="size-3.5" />Private</span>}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{e.body}</p>
          {e.linked_type && <p className="font-mono text-[11px] text-muted-foreground">{humanize(e.linked_type)} · {e.linked_id}</p>}
          {!!e.addenda?.length && (
            <ul className="flex flex-col gap-2 border-l-2 pl-3">
              {e.addenda.map((a) => (
                <li key={a.id} className="text-sm">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CornerDownRight className="size-3" />Addendum · {a.author_name} · {fmtDate(a.created_at)}</p>
                  <p className="whitespace-pre-wrap">{a.body}</p>
                </li>
              ))}
            </ul>
          )}
          {open ? (
            <form onSubmit={addendum} className="flex flex-col gap-2">
              <Textarea aria-label="Addendum" rows={2} required minLength={3} value={text} onChange={(x) => setText(x.target.value)} />
              <div className="flex gap-2"><Button size="sm">Save addendum</Button><Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
            </form>
          ) : <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(true)}><CornerDownRight />Add addendum</Button>}
        </CardContent>
      </Card>
    </li>
  );
}
