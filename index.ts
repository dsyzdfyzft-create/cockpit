import { createClient } from "npm:@supabase/supabase-js@2";
import { day } from "../_shared/utils.ts";
import { ATH, icu, minutes, round } from "../_shared/coach.ts";
import { target, workoutAdvice } from "../_shared/scores.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Ton objectif principal : ajuste la date dès qu'elle est connue
const OBJECTIF = { nom: "Triathlon M", date: "2027-06-13" };

// Autorise la page hébergée sur GitHub Pages à lire ces données
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-key, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Seule une page qui connaît ta clé peut lire tes données
  const cle = Deno.env.get("DASHBOARD_KEY");
  if (!cle || req.headers.get("x-key") !== cle) return json({ error: "forbidden" }, 403);

  const depuis = day(-90);

  // Données de ta base Supabase
  const [scores, nuits, ressenti, seances, records] = await Promise.all([
    sb.from("daily_scores")
      .select("date, recovery, strain, sleep_perf, sleep_need_min, bedtime, acwr, alert, details")
      .gte("date", depuis).order("date"),
    sb.from("nights")
      .select("date, sleep_start, sleep_end, asleep_min, in_bed_min, deep_min, rem_min, hrv_ms, rhr_bpm")
      .gte("date", depuis).order("date"),
    sb.from("wellness").select("date, forme, courbatures").gte("date", depuis).order("date"),
    sb.from("activities")
      .select("id, start_date, sport, duration_s, avg_hr, trimp, tss, load_source")
      .gte("start_date", depuis).order("start_date"),
    sb.from("power_records").select("duration_s, watts, date").order("duration_s"),
  ]);

  // Données d'Intervals.icu : forme (CTL/ATL), séances analysées, plan, FTP
  const [forme, icuActs, events, athlete] = await Promise.all([
    icu(`/athlete/${ATH()}/wellness?oldest=${depuis}&newest=${day()}`),
    icu(`/athlete/${ATH()}/activities?oldest=${day(-42)}&newest=${day()}`),
    icu(`/athlete/${ATH()}/events?oldest=${day()}&newest=${day(14)}`),
    icu(`/athlete/${ATH()}`),
  ]);

  const sc = scores.data ?? [];
  const dernier = sc.at(-1) ?? null;
  const nuitDuJour = dernier ? (nuits.data ?? []).find((n: any) => n.date === dernier.date) ?? null : null;

  const plan = (Array.isArray(events) ? events : [])
    .filter((e: any) => e.category === "WORKOUT")
    .map((e: any) => ({
      date: String(e.start_date_local ?? "").slice(0, 10),
      nom: e.name ?? "Séance",
      sport: e.type ?? "",
      duree_min: minutes(e.moving_time) ?? null,
      charge: round(e.icu_training_load) ?? null,
      description: String(e.description ?? "").slice(0, 400),
    }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date));

  const seancesIcu = (Array.isArray(icuActs) ? icuActs : [])
    .map((a: any) => ({
      id: a.id,
      date: String(a.start_date_local ?? "").slice(0, 10),
      nom: a.name ?? "Séance",
      sport: a.type ?? "",
      duree_min: minutes(a.moving_time) ?? null,
      distance_km: a.distance ? round(a.distance / 1000, 1) : null,
      tss: round(a.icu_training_load) ?? null,
      if: typeof a.icu_intensity === "number" ? round(a.icu_intensity / 100, 2) : null,
      puissance_moyenne_w: round(a.icu_average_watts ?? a.average_watts) ?? null,
      puissance_np_w: round(a.icu_weighted_avg_watts) ?? null,
      fc_moyenne: round(a.average_heartrate) ?? null,
      ef: round(a.icu_efficiency_factor, 2) ?? null,
      decouplage: round(a.decoupling, 1) ?? null,
      eftp: round(a.icu_pm_ftp) ?? null,
    }))
    .sort((a: any, b: any) => b.date.localeCompare(a.date));

  const ride = (athlete?.sportSettings ?? []).find((s: any) => (s.types ?? []).includes("Ride"));

  return json({
    genere_le: new Date().toISOString(),
    objectif: OBJECTIF,
    aujourdhui: dernier ? {
      date: dernier.date,
      est_aujourdhui: dernier.date === day(),
      recovery: dernier.recovery,
      strain: dernier.strain,
      sleep_perf: dernier.sleep_perf,
      sleep_need_min: dernier.sleep_need_min,
      bedtime: dernier.bedtime,
      acwr: dernier.acwr,
      alert: dernier.alert,
      regularite: dernier.details?.regularite ?? null,
      cible: target(dernier.recovery),
      conseil: workoutAdvice(dernier.recovery),
      dormi_min: nuitDuJour?.asleep_min ?? null,
      hrv_ms: round(nuitDuJour?.hrv_ms, 1) ?? null,
      rhr_bpm: nuitDuJour?.rhr_bpm ?? null,
    } : null,
    prevu_aujourdhui: plan.filter((p: any) => p.date === day()),
    scores: sc.map((s: any) => ({
      date: s.date, recovery: s.recovery, strain: s.strain, sleep_perf: s.sleep_perf,
      sleep_need_min: s.sleep_need_min, acwr: s.acwr, alert: s.alert, regularite: s.details?.regularite ?? null,
    })),
    nuits: nuits.data ?? [],
    ressenti: ressenti.data ?? [],
    seances: seances.data ?? [],
    records: records.data ?? [],
    charge: (Array.isArray(forme) ? forme : []).map((w: any) => ({
      date: w.id,
      ctl: round(w.ctl, 1) ?? null,
      atl: round(w.atl, 1) ?? null,
      tsb: typeof w.ctl === "number" && typeof w.atl === "number" ? round(w.ctl - w.atl, 1) : null,
    })),
    seances_icu: seancesIcu,
    plan,
    ftp: {
      reglee: ride?.ftp ?? null,
      eftp_recentes: seancesIcu.filter((a: any) => a.eftp).slice(0, 8).map((a: any) => ({ date: a.date, eftp: a.eftp })),
    },
  });
});
