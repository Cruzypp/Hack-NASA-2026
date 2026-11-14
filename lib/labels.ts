// Human-readable labels for keys and enums coming from the API.

const METRICS: Record<string, string> = {
  resting_hr: "Resting heart rate", heart_rate: "Heart rate", systolic_bp: "Systolic blood pressure",
  diastolic_bp: "Diastolic blood pressure", body_temp: "Body temperature", body_mass: "Body mass",
  sleep_hours: "Sleep duration", rpe: "Perceived exertion",
};

const FACTORS: Record<string, string> = {
  post_exercise: "Post-exercise", short_sleep: "Short sleep", recent_eva: "Recent EVA",
};

const ACRONYMS = new Set(["EVA", "BP", "HR", "CMO", "ECG", "CO2", "CAD", "REM", "HERA", "CHECS", "NASA"]);

/** "CREW_MEDICAL_OFFICER" → "Crew medical officer", "PHYSIO_DEVIATION" → "Physio deviation". */
export function humanize(key: string): string {
  const words = key.split(/[_\s-]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const metricLabel = (key: string) => METRICS[key] ?? humanize(key);
export const factorLabel = (key: string) => FACTORS[key] ?? humanize(key);
/** Lower-case form for use mid-sentence ("Signed by crew medical officer"). */
export const roleLabel = (role: string) => humanize(role).toLowerCase();
/** Role as a title ("Crew Medical Officer"). */
export const roleTitle = (role: string) => humanize(role).replace(/\b\w/g, (c) => c.toUpperCase());
