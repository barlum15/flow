// Load disaggregation (NILM) with a Factorial Hidden Markov Model.
//
// Every appliance is a small Markov chain over its power states (from the
// appliance library). The smart meter reading is modelled as the sum of the
// state powers of all appliances plus Gaussian noise. After each reading an
// online forward filter updates the probability of every joint state; from
// that we derive per-appliance probabilities and power estimates.
//
// Input: one total power value per minute. Nothing else.

const OUTLIER_RANGE_W = 10000; // width of the uniform outlier component
const PRUNE_BELOW = 1e-9; // joint states with less posterior mass are skipped

function normalize(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / sum);
}

/** Builds the per-minute transition matrix of one appliance. */
function transitionMatrix(states) {
  const index = new Map(states.map((s, i) => [s.name, i]));
  return states.map((state, i) => {
    const row = new Array(states.length).fill(0);
    const stay = 1 - 1 / Math.max(1, state.duration);
    row[i] = stay;
    for (const [name, p] of Object.entries(state.next)) row[index.get(name)] += (1 - stay) * p;
    return normalize(row);
  });
}

export class FhmmDisaggregator {
  /**
   * @param {object} library appliance library
   * @param {{ only?: Iterable<string> }} [options] restrict the model to these
   *   appliance IDs (the appliances known to be in the house)
   */
  constructor(library, { only } = {}) {
    this.noiseVar = library.noiseW ** 2;
    this.outlier = library.outlierProbability ?? 0.01;
    const include = only ? new Set(only) : null;

    this.appliances = library.appliances.filter((a) => !include || include.has(a.id)).map((a) => {
      const initial = a.initial
        ? normalize(a.states.map((s) => a.initial[s.name] ?? 0))
        : normalize(a.states.map((s, i) => (i === 0 ? 0.9 : 0.1 / (a.states.length - 1))));
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        states: a.states,
        offState: a.states.findIndex((s) => s.power === 0),
        transition: transitionMatrix(a.states),
        initial,
      };
    });

    // Joint state space: mixed-radix index over all appliances.
    let stride = 1;
    for (const a of this.appliances) {
      a.stride = stride;
      stride *= a.states.length;
    }
    this.size = stride;

    // Per joint state: the state of every appliance, total mean and variance.
    this.stateOf = this.appliances.map(() => new Uint8Array(this.size));
    this.mean = new Float64Array(this.size);
    this.variance = new Float64Array(this.size);
    this.alpha = new Float64Array(this.size);
    this.scratch = new Float64Array(this.size);

    for (let j = 0; j < this.size; j++) {
      let mean = 0;
      let variance = this.noiseVar;
      let prior = 1;
      this.appliances.forEach((a, d) => {
        const s = Math.floor(j / a.stride) % a.states.length;
        this.stateOf[d][j] = s;
        mean += a.states[s].power;
        variance += a.states[s].sd ** 2;
        prior *= a.initial[s];
      });
      this.mean[j] = mean;
      this.variance[j] = variance;
      this.alpha[j] = prior;
    }

    this.normalisation = 1 / Math.sqrt(2 * Math.PI * this.noiseVar);
    this.lastUpdateMs = 0;
  }

  /** Prediction step: applies each appliance's transition matrix along its axis. */
  predict() {
    for (let d = 0; d < this.appliances.length; d++) {
      const { stride, transition } = this.appliances[d];
      const K = transition.length;
      const states = this.stateOf[d];
      const next = this.scratch.fill(0);
      for (let j = 0; j < this.size; j++) {
        const p = this.alpha[j];
        if (p < PRUNE_BELOW) continue;
        const s = states[j];
        const base = j - s * stride;
        const row = transition[s];
        for (let b = 0; b < K; b++) next[base + b * stride] += p * row[b];
      }
      this.scratch = this.alpha;
      this.alpha = next;
    }
  }

  /**
   * Processes one smart meter reading (average watts of one minute) and
   * returns the current estimate for every appliance.
   */
  update(watts) {
    const started = performance.now();
    this.predict();

    // Correction step: Gaussian likelihood with a small uniform outlier part.
    //
    // The spread of a state ("sd") describes how far a real appliance may be
    // from its nominal power. That deviation is persistent, not new noise every
    // minute. A normalised Gaussian would reward the joint state with the
    // narrowest spread again in every minute, so two equally good explanations
    // would drift towards the "sharper" one. We therefore only penalise the
    // distance to the expected total (Mahalanobis term) and use a common
    // normalisation for all joint states.
    let sum = 0;
    for (let j = 0; j < this.size; j++) {
      if (this.alpha[j] < PRUNE_BELOW) {
        this.alpha[j] = 0;
        continue;
      }
      const r = watts - this.mean[j];
      const likelihood =
        (1 - this.outlier) * this.normalisation * Math.exp((-r * r) / (2 * this.variance[j])) +
        this.outlier / OUTLIER_RANGE_W;
      this.alpha[j] *= likelihood;
      sum += this.alpha[j];
    }
    for (let j = 0; j < this.size; j++) this.alpha[j] /= sum;

    const result = this.estimate(watts);
    this.lastUpdateMs = performance.now() - started;
    return result;
  }

  /** Derives per-appliance probabilities and power estimates from the posterior. */
  estimate(watts) {
    const n = this.appliances.length;
    const stateProbs = this.appliances.map((a) => new Float64Array(a.states.length));
    const est = new Float64Array(n);
    const est2 = new Float64Array(n);
    let best = 0;

    for (let j = 0; j < this.size; j++) {
      const w = this.alpha[j];
      if (w < PRUNE_BELOW) continue;
      if (w > best) best = w;

      // Given the joint state, the reading is split among the appliances in
      // proportion to their variance (conditional mean of a Gaussian sum).
      const v = this.variance[j];
      const r = (watts - this.mean[j]) / v;

      for (let d = 0; d < n; d++) {
        const state = this.appliances[d].states[this.stateOf[d][j]];
        stateProbs[d][this.stateOf[d][j]] += w;
        const sd2 = state.sd ** 2;
        const c = state.power + sd2 * r;
        const condVar = sd2 - (sd2 * sd2) / v;
        est[d] += w * c;
        est2[d] += w * (c * c + condVar);
      }
    }

    const appliances = this.appliances.map((a, d) => {
      const probs = Array.from(stateProbs[d]);
      const top = probs.indexOf(Math.max(...probs));
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        pOn: 1 - (a.offState >= 0 ? probs[a.offState] : 0),
        state: a.states[top].name,
        stateProbability: probs[top],
        estimate: Math.max(0, est[d]),
        sd: Math.sqrt(Math.max(0, est2[d] - est[d] * est[d])),
      };
    });

    // Residual = measured − sum of the estimates. Appliances + residual always
    // add up to the reading: positive = consumption no appliance explains,
    // negative = the appliances are estimated higher than what was measured.
    const residual = watts - appliances.reduce((sum, a) => sum + a.estimate, 0);

    return { total: watts, appliances, residual, confidence: best };
  }
}

/**
 * Rolling accuracy of the estimates against the simulation's ground truth
 * (which the algorithm never sees).
 */
export class NilmMetrics {
  /**
   * @param {{ windowMinutes?: number, onThresholdW?: number, thresholds?: Record<string, number> }} options
   *   thresholds: on/off threshold per device (W), e.g. from an external model
   */
  constructor({ windowMinutes = 1440, onThresholdW = 5, thresholds = {} } = {}) {
    this.windowMinutes = windowMinutes;
    this.onThresholdW = onThresholdW;
    this.thresholds = thresholds;
    this.entries = [];
    this.sums = { correct: 0, count: 0, absError: 0, trueEnergy: 0 };
  }

  add(t, result, truth) {
    const entry = { t, correct: 0, count: 0, absError: 0, trueEnergy: 0 };
    for (const a of result.appliances) {
      const actual = truth[a.id] ?? 0;
      if (a.pOn != null) {
        const predictedOn = a.pOn >= 0.5;
        const actualOn = actual > (this.thresholds[a.id] ?? this.onThresholdW);
        entry.correct += predictedOn === actualOn ? 1 : 0;
        entry.count += 1;
      }
      // Energy accuracy only for models that estimate power.
      if (a.estimate != null) {
        entry.absError += Math.abs(a.estimate - actual);
        entry.trueEnergy += actual;
      }
    }
    this.entries.push(entry);
    this.apply(entry, 1);

    while (this.entries.length && this.entries[0].t <= t - this.windowMinutes) {
      this.apply(this.entries.shift(), -1);
    }
  }

  apply(entry, sign) {
    for (const key of Object.keys(this.sums)) this.sums[key] += sign * entry[key];
  }

  /** Share of appliance-minutes where on/off was classified correctly. */
  get onOffAccuracy() {
    return this.sums.count ? this.sums.correct / this.sums.count : null;
  }

  /** Energy assignment accuracy (Kolter & Johnson): 1 - Σ|est - true| / (2 Σ true). */
  get energyAccuracy() {
    return this.sums.trueEnergy ? Math.max(0, 1 - this.sums.absError / (2 * this.sums.trueEnergy)) : null;
  }
}
