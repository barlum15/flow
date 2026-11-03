// Where the power of each device comes from.
//
// MockSource:     the placeholder curves in data/devices.json (always available)
// RecordedSource: real measurements converted by tools/import_h5.py into
//                 data/real/ (one JSON file per day, one value per minute).
//                 That folder is local only and never committed.
//
// Time is measured in simulated minutes since the start of the first day.

import { MINUTES_PER_DAY, sampleCurve } from "./simulation.js";

const MANIFEST_URL = "data/real/manifest.json";
const DAY_URL = (date) => `data/real/days/${date}.json`;

export class MockSource {
  constructor() {
    this.kind = "mock";
    this.label = "Mock data";
    this.startTime = 6 * 60; // 06:00 on day 1
  }

  hasDevice() {
    return true;
  }

  isReady() {
    return true;
  }

  prefetch() {}

  powerAt(device, time) {
    return sampleCurve(device.curve, (time % MINUTES_PER_DAY) / 60);
  }

  dayLabel(dayIndex) {
    return `Day ${dayIndex + 1}`;
  }
}

export class RecordedSource {
  /** Loads data/real/manifest.json; resolves to null when no recorded data exists. */
  static async load() {
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) return null;
      const manifest = await response.json();
      if (!Array.isArray(manifest.days) || manifest.days.length === 0) return null;
      return new RecordedSource(manifest);
    } catch {
      return null;
    }
  }

  constructor(manifest) {
    this.kind = "recorded";
    this.manifest = manifest;
    this.days = manifest.days;
    this.devices = new Set(manifest.devices);
    this.label = manifest.source || "Recorded data";
    this.startTime = 6 * 60; // 06:00 on the first recorded day
    this.cache = new Map(); // day index -> { status, data }
    this.offset = 0; // recorded day shown on simulation day 1
    this.fixed = null; // when set, this recorded day repeats forever ("fixed date")
  }

  get range() {
    return `${this.manifest.start} – ${this.manifest.end}`;
  }

  /** Recorded day index for a simulation day (0 = first simulated day). */
  resolve(simDay) {
    if (this.fixed !== null) return this.fixed;
    const n = this.days.length;
    return (((simDay + this.offset) % n) + n) % n; // wraps around at the end
  }

  /** Index into this.days for a simulation time. */
  dayIndex(time) {
    return this.resolve(Math.floor(time / MINUTES_PER_DAY));
  }

  /** Makes the given recorded day the first simulated day (keeps "repeat" on if it was). */
  jumpTo(index) {
    this.offset = index;
    if (this.fixed !== null) this.fixed = index;
  }

  /**
   * Turns "repeat this day" on or off for the day shown on simulation day
   * `simDay`. Turning it off continues normally with the following days.
   */
  setRepeat(simDay, on) {
    if (on) {
      this.fixed = this.resolve(simDay);
    } else if (this.fixed !== null) {
      this.offset = this.fixed - simDay;
      this.fixed = null;
    }
  }

  get repeating() {
    return this.fixed !== null;
  }

  hasDevice(id) {
    return this.devices.has(id);
  }

  load(index) {
    if (this.cache.has(index)) return;
    const entry = { status: "loading", data: null };
    this.cache.set(index, entry);
    fetch(DAY_URL(this.days[index]))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        entry.status = "ready";
        entry.data = data;
      })
      .catch((error) => {
        // A missing day is treated as "no data" so the simulation can continue.
        console.warn(`Could not load recorded day ${this.days[index]}:`, error);
        entry.status = "ready";
        entry.data = { devices: {} };
      });

    // Keep memory small: forget days far away from the ones in use.
    if (this.cache.size > 6) {
      for (const key of this.cache.keys()) {
        if (key !== index && this.cache.size > 6) this.cache.delete(key);
      }
    }
  }

  /** Starts loading the day of `time` and the following day. */
  prefetch(time) {
    const index = this.dayIndex(time);
    this.load(index);
    this.load((index + 1) % this.days.length);
  }

  isReady(time) {
    return this.cache.get(this.dayIndex(time))?.status === "ready";
  }

  powerAt(device, time) {
    const entry = this.cache.get(this.dayIndex(time));
    const values = entry?.data?.devices?.[device.id];
    if (!values) return 0;
    const value = values[Math.floor(time % MINUTES_PER_DAY)];
    return value == null || value < 0 ? 0 : value; // gaps count as 0 W
  }

  /** Date (YYYY-MM-DD) shown on simulation day `simDay`. */
  dateOf(simDay) {
    return this.days[this.resolve(simDay)];
  }

  dayLabel(dayIndex) {
    const date = new Date(`${this.dateOf(dayIndex)}T12:00:00`);
    return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
}
