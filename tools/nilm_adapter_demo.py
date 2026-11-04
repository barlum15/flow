"""Demo adapter for the Enerlyza model API (no trained models needed).

It provides two small Combinatorial Optimization (CO) models so the whole
chain app -> tools/serve.py -> adapter -> app can be tested without the real
NILM framework. Use it with this models/config.json:

    {"adapter": "tools/nilm_adapter_demo.py", "settings": {}}

An adapter only has to provide the two functions below; see
tools/nilm_adapter_template.py for the version that calls the real framework.
"""

from itertools import product

import numpy as np

# Typical "on" power (W) and reactive power (var) of each appliance.
NOMINAL = {
    "ahu": (45, 20),
    "coffee_maker": (1000, 30),
    "dishwasher": (1800, 150),
    "electric_stove": (2300, 40),
    "fridge": (105, 60),
    "tumble_dryer": (2400, 300),
    "washing_machine": (2000, 250),
    "tv": (100, 20),
    "lighting": (150, 10),
}
ALWAYS_ON = {"ahu"}  # the ventilation never switches off


def list_models(settings):
    """Describes the available models. Called by GET /api/models."""
    devices = list(NOMINAL)
    thresholds = {d: 10 for d in devices}
    return [
        {
            "id": "demo-co-p",
            "name": "Demo · CO (P only)",
            "group": "Demo",
            "needsReactive": False,
            "devices": devices,
            "outputs": {"power": True, "on": True, "prob": False},
            "window": 1,
            "center": False,
            "thresholds": thresholds,
            "trained": False,
        },
        {
            "id": "demo-co-pq",
            "name": "Demo · CO (P + Q, with probabilities)",
            "group": "Demo",
            "needsReactive": True,
            "devices": devices,
            "outputs": {"power": True, "on": True, "prob": True},
            "window": 1,
            "center": False,
            "thresholds": thresholds,
            "trained": False,
        },
        {
            "id": "demo-co-window",
            "name": "Demo · CO with 99-minute window",
            "group": "Demo",
            "needsReactive": False,
            "devices": devices,
            "outputs": {"power": True, "on": True, "prob": False},
            "window": 99,
            "center": True,  # estimates the middle of the window, like Seq2Point
            "thresholds": thresholds,
            "trained": False,
        },
    ]


def predict(model_id, frame, settings):
    """
    Estimates every device for every minute of `frame`.

    frame: pandas DataFrame, 1-minute index (local time), columns "P" (W) and,
           if the model needs it, "Q" (var). Gaps are NaN.
    returns: {device: {"power": [...], "on": [...], "prob": [...] or None}},
             one value per row of `frame`.
    """
    devices = list(NOMINAL)
    use_q = model_id == "demo-co-pq" and "Q" in frame
    if model_id == "demo-co-window":
        # Smooth the input with a centred 99-minute window (edges use what exists).
        frame = frame.assign(P=frame["P"].rolling(99, center=True, min_periods=1).median())

    # All on/off combinations of the appliances (always-on ones fixed to on).
    combos = np.array([c for c in product((0, 1), repeat=len(devices))
                       if all(c[i] for i, d in enumerate(devices) if d in ALWAYS_ON)], dtype=float)
    p_nom = np.array([NOMINAL[d][0] for d in devices])
    q_nom = np.array([NOMINAL[d][1] for d in devices])
    p_combo = combos @ p_nom
    q_combo = combos @ q_nom

    p = frame["P"].to_numpy(dtype=float)
    dist = (p[:, None] - p_combo[None, :]) ** 2
    if use_q:
        q = frame["Q"].to_numpy(dtype=float)
        dist = dist + (np.nan_to_num(q)[:, None] - q_combo[None, :]) ** 2

    best = np.argmin(np.nan_to_num(dist, nan=np.inf), axis=1)
    on = combos[best]
    missing = ~np.isfinite(p)

    result = {}
    if use_q:
        # Probability of "on": soft weighting of all combinations by their distance.
        scale = 2 * 80.0 ** 2
        w = np.exp(-(dist - dist.min(axis=1, keepdims=True)) / scale)
        w /= w.sum(axis=1, keepdims=True)
        prob = w @ combos

    for i, device in enumerate(devices):
        power = np.where(missing, np.nan, on[:, i] * p_nom[i])
        result[device] = {
            "power": power.tolist(),
            "on": np.where(missing, np.nan, on[:, i]).tolist(),
            "prob": np.where(missing, np.nan, prob[:, i]).tolist() if use_q else None,
        }
    return result
