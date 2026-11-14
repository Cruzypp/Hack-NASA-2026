"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Satellite, ShieldCheck, Stethoscope, UserRound, Wrench } from "lucide-react";
import { api, session, type User } from "@/lib/api";
import { ErrorAlert } from "@/components/astra";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Demo accounts only. PINs are shown because this is a simulation environment.
const DEMO = [
  { username: "vega", pin: "1111", label: "M. Vega", role: "Astronaut · CM-01", icon: UserRound },
  { username: "okafor", pin: "2222", label: "Dr. K. Okafor", role: "Crew Medical Officer · CM-02", icon: Stethoscope },
  { username: "lindqvist", pin: "3333", label: "Dr. S. Lindqvist", role: "Flight Surgeon · ground", icon: ShieldCheck },
  { username: "ops", pin: "4444", label: "Mission Ops", role: "Mission Operator", icon: Wrench },
];

export default function Login() {
  const router = useRouter();
  const [username, setUsername] = useState("vega");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>("/auth/login", { body: { username, pin } });
      session.set(r.token);
      router.push("/dashboard");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-screen lg:grid-cols-2">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r p-10 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -right-40 -top-40 size-[560px] rounded-full border border-primary/15" />
          <div className="absolute -right-20 -top-20 size-[400px] rounded-full border border-primary/10" />
          <div className="absolute right-24 top-24 size-[240px] rounded-full bg-primary/10 blur-3xl" />
        </div>
        <div className="relative flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Satellite className="size-5" /></div>
          <span className="font-mono text-sm font-semibold tracking-[0.3em] text-primary">ASTRA HEALTH</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">Preventive health, tracked across the whole mission.</h1>
          <p className="mt-4 text-muted-foreground">
            Follows each crew member&apos;s approved protocol, compares data against their own baseline, and keeps working through loss of signal.
          </p>
          <dl className="mt-8 grid grid-cols-3 gap-4 font-mono text-xs">
            {[["Protocols", "versioned"], ["Anomalies", "explainable"], ["Sync", "store & forward"]].map(([k, v]) => (
              <div key={k} className="rounded-lg border bg-card/50 p-3"><dt className="text-muted-foreground">{k}</dt><dd className="mt-1 text-foreground">{v}</dd></div>
            ))}
          </dl>
        </div>
      </section>

      <section className="flex items-center justify-center p-4 md:p-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>Select a crew or staff account.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-5">
              <fieldset className="grid gap-2" aria-label="Account">
                {DEMO.map((d) => (
                  <label key={d.username}
                    className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 has-focus-visible:ring-2 has-focus-visible:ring-ring",
                      username === d.username && "border-primary bg-primary/5")}>
                    <input type="radio" name="user" className="sr-only" checked={username === d.username} onChange={() => { setUsername(d.username); setPin(""); }} />
                    <d.icon className={cn("size-4", username === d.username ? "text-primary" : "text-muted-foreground")} aria-hidden />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{d.label}</span>
                      <span className="block text-xs text-muted-foreground">{d.role}</span>
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">PIN {d.pin}</span>
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-2">
                <Label htmlFor="pin">PIN</Label>
                <Input id="pin" type="password" inputMode="numeric" autoComplete="current-password" className="font-mono tracking-[0.4em]"
                  value={pin} onChange={(e) => setPin(e.target.value)} required minLength={4} />
              </div>
              <ErrorAlert error={error} title="Sign-in failed" />
              <Button size="lg" disabled={busy}>{busy ? "Signing in…" : <>Sign in <ArrowRight /></>}</Button>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
