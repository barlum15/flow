// Core simulation model: devices with consumption curves and a smart meter
// that only ever sees the sum of all requests.

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
  constructor({ recordIntervalMinutes = 5 } = {}) {
    this.recordIntervalMinutes = recordIntervalMinutes;
    this.pending = 0; // sum of requests in the current tick
    this.total = 0; // last summed total in watts
    this.energyKWh = 0; // accumulated energy for the current day
    this.records = []; // stored totals: { minute, watts }
    this.lastRecordedMinute = -Infinity;
  }

  /** Devices call this. The meter does not know who is asking - only how much. */
  request(watts) {
    this.pending += watts;
  }

  /** Closes the current tick: sums the requests and stores the total. */
  commit(minuteOfDay, dtHours) {
    this.total = this.pending;
    this.pending = 0;
    this.energyKWh += (this.total * dtHours) / 1000;

    const slot = Math.floor(minuteOfDay / this.recordIntervalMinutes) * this.recordIntervalMinutes;
    if (slot !== this.lastRecordedMinute) {
      this.records.push({ minute: slot, watts: this.total });
      this.lastRecordedMinute = slot;
    }
  }

  resetDay() {
    this.records = [];
    this.energyKWh = 0;
    this.lastRecordedMinute = -Infinity;
  }
}

export class Simulation {
  constructor(devices, meter, { startHour = 6 } = {}) {
    this.devices = devices;
    this.meter = meter;
    this.minuteOfDay = startHour * 60;
    this.day = 1;
  }

  /** Advances simulated time by the given number of minutes. */
  step(minutes) {
    let next = this.minuteOfDay + minutes;
    if (next >= HOURS_PER_DAY * 60) {
      next -= HOURS_PER_DAY * 60;
      this.day += 1;
      this.meter.resetDay();
    }
    this.minuteOfDay = next;

    const hour = this.minuteOfDay / 60;
    for (const device of this.devices) device.update(hour, this.meter);
    this.meter.commit(this.minuteOfDay, minutes / 60);
  }
}
