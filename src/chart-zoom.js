// Shared time-axis zoom for the smart meter chart and the disaggregation chart.
//
// The visible window is stored as fractions (a..b) of the base range (the last
// 60 minutes, or the whole day), so the same zoom applies to both charts and
// keeps working while the live range moves with the clock.
//
//   mouse wheel   zoom in/out around the mouse position
//   drag          move the visible window (a plain click still selects a minute)
//   − / + / Reset buttons with the class "zoom-out", "zoom-in", "zoom-reset"

const MIN_SPAN_MINUTES = 10; // never zoom in further than 10 minutes
const WHEEL_STEP = 0.8; // one wheel notch shows 80 % of the window
const DRAG_THRESHOLD_PX = 4;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360];

/** Label spacing (minutes) for a visible span: at most about 8 labels. */
export function tickFor(spanMinutes) {
  return TICK_STEPS.find((step) => spanMinutes / step <= 8) ?? 360;
}

export class TimeZoom {
  constructor() {
    this.a = 0;
    this.b = 1;
    this.baseSpan = 1440;
    this.listeners = new Set();
  }

  get zoomed() {
    return this.a > 0 || this.b < 1;
  }

  /** Applies the zoom to a base range { from, to } and adds a fitting tick spacing. */
  apply(base) {
    this.baseSpan = base.to - base.from;
    const from = base.from + this.a * this.baseSpan;
    const to = base.from + this.b * this.baseSpan;
    return { from, to, tickEvery: tickFor(to - from) };
  }

  set(a, b) {
    const minWidth = Math.min(1, MIN_SPAN_MINUTES / this.baseSpan);
    let width = Math.min(1, Math.max(minWidth, b - a));
    a = Math.min(Math.max(0, a), 1 - width);
    this.a = a;
    this.b = a + width;
    for (const listener of this.listeners) listener();
  }

  /** Zooms by `factor` (< 1 = in) keeping the point at fraction `at` (0..1 of the window) in place. */
  zoom(factor, at = 0.5) {
    const width = this.b - this.a;
    const center = this.a + at * width;
    const next = width * factor;
    this.set(center - at * next, center - at * next + next);
  }

  /** Moves the window by `delta` (fraction of the window width). */
  pan(delta) {
    const width = this.b - this.a;
    this.set(this.a + delta * width, this.b + delta * width);
  }

  reset() {
    this.set(0, 1);
  }

  /**
   * Adds wheel zoom and drag panning to a chart canvas. `getLayout` returns
   * the last plot geometry { left, width } of that chart.
   */
  attach(canvas, getLayout) {
    canvas.addEventListener(
      "wheel",
      (event) => {
        const layout = getLayout();
        if (!layout) return;
        event.preventDefault();
        const at = Math.min(1, Math.max(0, (event.offsetX - layout.left) / layout.width));
        this.zoom(event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, at);
      },
      { passive: false },
    );

    let drag = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, moved: false };
      canvas.dataset.dragged = "";
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const layout = getLayout();
      const dx = event.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("dragging");
      }
      if (layout) this.pan(-dx / layout.width);
      drag.x = event.clientX;
    });
    const end = () => {
      if (drag?.moved) canvas.dataset.dragged = "1"; // the following click is not a selection
      drag = null;
      canvas.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /** Wires − / + / Reset buttons inside `container`. */
  attachButtons(container) {
    container.querySelector(".zoom-in")?.addEventListener("click", () => this.zoom(0.5));
    container.querySelector(".zoom-out")?.addEventListener("click", () => this.zoom(2));
    container.querySelector(".zoom-reset")?.addEventListener("click", () => this.reset());
    const update = () => container.classList.toggle("is-zoomed", this.zoomed);
    this.listeners.add(update);
    update();
  }
}

/** True when the click that just happened ended a drag (and must not select a minute). */
export function wasDrag(canvas) {
  const dragged = canvas.dataset.dragged === "1";
  canvas.dataset.dragged = "";
  return dragged;
}
