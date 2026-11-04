// External NILM models served by tools/serve.py (see README, "External NILM
// Models"). The browser sends the smart meter minutes of the day and gets,
// per device and minute, power, on/off and (if the model has it) a probability.

import { MINUTES_PER_DAY } from "./simulation.js";

/**
 * Device IDs of the app are lower case ("ahu"); a framework may use other
 * spellings ("AHU"). All IDs coming from the model server are matched this way.
 */
export const canonicalId = (id) => String(id).toLowerCase();

const remapKeys = (object) => Object.fromEntries(Object.entries(object ?? {}).map(([k, v]) => [canonicalId(k), v]));

/** Asks the local server which models exist. Never throws: no server = no models. */
export async function loadExternalModels() {
  try {
    const response = await fetch("api/models", { cache: "no-store" });
    if (!response.ok) return { available: false, reason: "no model server", models: [] };
    const result = await response.json();
    for (const m of result.models ?? []) {
      m.devices = (m.devices ?? []).map(canonicalId);
      m.thresholds = remapKeys(m.thresholds);
    }
    return result;
  } catch {
    return { available: false, reason: "no model server", models: [] };
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Sends the records (consecutive minutes) to the server and returns its answer.
 * @param {object} model model description from /api/models
 * @param {{t:number, watts:number, vars:number}[]} records
 * @param {(dayIndex:number) => string} dateOfDay date (YYYY-MM-DD) of a simulation day
 */
export async function requestDisaggregation(model, records, { dateOfDay, timezone, withReactive }) {
  const first = records[0].t;
  const minute = first % MINUTES_PER_DAY;
  const body = {
    model: model.id,
    start: `${dateOfDay(Math.floor(first / MINUTES_PER_DAY))}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`,
    timezone,
    P: records.map((r) => r.watts),
    Q: withReactive ? records.map((r) => r.vars ?? 0) : null,
  };
  const response = await fetch("api/disaggregate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `model server error ${response.status}`);
  payload.devices = remapKeys(payload.devices);
  return payload;
}

/**
 * Turns the answer into one result per record, in the same shape as the
 * built-in model: { total, appliances: [{ id, name, color, pOn, state,
 * stateProbability, estimate, sd }], residual, confidence }.
 * Quantities a model does not produce are null.
 */
export function toResults(model, answer, records, appliances) {
  const thresholds = model.thresholds ?? {};
  return records.map((record, i) => {
    let sum = 0;
    let hasPower = false;
    const list = appliances.map((a) => {
      const out = answer.devices[a.id] ?? {};
      const power = out.power?.[i] ?? null;
      const prob = out.prob?.[i] ?? null;
      const on = out.on?.[i] ?? null;
      let pOn = prob ?? on;
      if (pOn === null && power !== null) pOn = power > (thresholds[a.id] ?? 10) ? 1 : 0;
      if (power !== null) {
        hasPower = true;
        sum += power;
      }
      const isOn = pOn !== null && pOn >= 0.5;
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        pOn,
        state: pOn === null ? "–" : isOn ? "On" : "Off",
        stateProbability: prob === null ? null : isOn ? prob : 1 - prob,
        binary: prob === null, // on/off without a probability
        estimate: power === null ? null : Math.max(0, power),
        sd: null,
      };
    });
    return {
      total: record.watts,
      appliances: list,
      residual: hasPower ? record.watts - sum : null,
      confidence: null, // external models report no joint confidence
    };
  });
}
