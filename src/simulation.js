// Core simulation model: devices with consumption curves and a smart meter
// that only ever sees the sum of all requests.
//
// Time is measured in simulated minutes since day 1, 00:00.

export const MINUTES_PER_DAY = 1440;
const HOURS_PER_DAY = 24;

/** Returns the power (watts) of an hourly curve (24 values) at a given hour. */
export function sampleCurve(curve, hour) {
  const h = ((hour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  return curve[Math.floor(h)];
}

export class Device {
  constructor({ id, name, curve, ...appearance }) {
    this.id = id;
    this.name = name;
    this.curve = curve;
    Object.assign(this, appearance); // wall, plug, color, boxes (used by the view)
    this.enabled = true;
    this.power = 0; // current draw in watts
  }

  /** Computes the current draw and requests it from the smart meter. */
  update(hour, meter) {
    this.power = this.enabled ? sampleCurve(this.curve, hour) : 0;
    if (this.power > 0) meter.request(this.power);
  }
}

export class SmartMeter {
  constructor({ recordIntervalMinutes = 1, keepDays = 2 } = {}) {
    this.recordIntervalMinutes = recordIntervalMinutes;
    this.maxRecords = Math.ceil((keepDays * MINUTES_PER_DAY) / recordIntervalMinutes);

    this.pending = 0; // sum of requests in the current tick
    this.total = 0; // last summed total in watts

    this.readingKWh = 0; // meter reading: total energy since installation
    this.energyKWh = 0; // energy of the current day
    this.peakW = 0; // highest total of the current day

    this.records = []; // stored totals: { t, watts } (average watts per interval)
    this.slot = null; // start of the interval being recorded
    this.slotWattMinutes = 0;
    this.slotMinutes = 0;
  }

  /** Devices call this. The meter does not know who is asking - only how much. */
  request(watts) {
    this.pending += watts;
  }

  /**
   * Closes the current tick: sums the requests, meters the energy and stores
   * the average total per interval.
   * @param {number} time start of the tick in minutes since the simulation start
   * @param {number} minutes length of the tick in minutes
   */
  commit(time, minutes) {
    this.total = this.pending;
    this.pending = 0;

    const kWh = (this.total * minutes) / 60 / 1000;
    this.readingKWh += kWh;
    this.energyKWh += kWh;
    this.peakW = Math.max(this.peakW, this.total);

    const slot = Math.floor(time / this.recordIntervalMinutes) * this.recordIntervalMinutes;
    if (this.slot !== null && slot !== this.slot) this.closeSlot();
    this.slot = slot;
    this.slotWattMinutes += this.total * minutes;
    this.slotMinutes += minutes;
  }

  closeSlot() {
    if (this.slotMinutes > 0) {
      this.records.push({ t: this.slot, watts: this.slotWattMinutes / this.slotMinutes });
      if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.slotWattMinutes = 0;
    this.slotMinutes = 0;
  }

  resetDay() {
    this.energyKWh = 0;
    this.peakW = 0;
  }
}

export class Simulation {
  constructor(devices, meter, { startHour = 6 } = {}) {
    this.devices = devices;
    this.meter = meter;
    this.time = startHour * 60; // minutes since day 1, 00:00
  }

  get day() {
    return Math.floor(this.time / MINUTES_PER_DAY) + 1;
  }

  get minuteOfDay() {
    return this.time % MINUTES_PER_DAY;
  }

  /** Start of the current day in minutes since the simulation start. */
  get dayStart() {
    return this.time - this.minuteOfDay;
  }

  /** Advances simulated time by the given number of minutes. */
  step(minutes) {
    const start = this.time;
    const hour = (start % MINUTES_PER_DAY) / 60;
    for (const device of this.devices) device.update(hour, this.meter);
    this.meter.commit(start, minutes);

    const dayBefore = this.day;
    this.time += minutes;
    if (this.day !== dayBefore) this.meter.resetDay();
  }
}
