"""Template adapter: connects Enerlyza to the local NILM framework (nilm_framework).

HOW TO USE
  1. Copy this file to models/serve_adapter.py (models/ is in .gitignore, so
     your copy, your paths and your models stay local).
  2. Create models/config.json:
         {
           "adapter": "models/serve_adapter.py",
           "framework_path": "C:/path/to/the/folder/that/contains/nilm_framework",
           "settings": {
             "models_dir": "C:/path/to/the/trained/models",
             "building": "building_1",
             "file_pattern": "{model}_model.pkl"
           }
         }
  3. Fill in the places marked TODO with calls into your framework.
  4. Start the app with:  python tools/serve.py
     The console prints whether the adapter was loaded; GET
     http://localhost:8000/api/models lists the models.

CONTRACT (what tools/serve.py expects)
  list_models(settings) -> list of dicts, one per model:
      id, name, group            text
      needsReactive              True if the model needs Q (var) besides P (W)
      devices                    device IDs the model estimates (same IDs as the app)
      outputs                    {"power": bool, "on": bool, "prob": bool}
      window, center             input window length in minutes; center=True if the
                                 model estimates the middle of the window (then the
                                 last window//2 minutes are provisional live)
      thresholds                 {device: watts} on/off thresholds (cfg.get_on_threshold)
      trained                    True for trained models (enables the training-day warning)
      available, reason          optional: False + text if it cannot be used here
  predict(model_id, frame, settings) -> {device: {"power": [...], "on": [...], "prob": [...]}}
      frame: pandas DataFrame with a 1-minute DatetimeIndex (local time) and the
      columns "P" and "Q" (Q only when recorded data has it). Missing minutes
      are NaN. Each list must have one value per row of frame; use None for a
      quantity the model does not produce (e.g. "power" for SVM).

SECURITY
  pickle.load runs code from the file. Only load your own model files.
"""

import pickle
import threading
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# Model registry (from the framework's model specification, holdout split)
# --------------------------------------------------------------------------
# All models work on 1-minute data. Per the specification they use [P, Q]
# (HMM family via prepare_markov_input, NMF/SC via apparent power sqrt(P²+Q²),
# classical ML via 15 features of [P, Q] windows, neural models via [P, Q]
# windows), so all of them need reactive power.

STATE_SPACE = {"power": True, "on": True, "prob": False}
CLASSIFIER = {"power": False, "on": True, "prob": True}
REGRESSION = {"power": True, "on": False, "prob": False}  # on/off from thresholds
DUAL_HEAD = {"power": True, "on": True, "prob": True}

MODELS = [
    # id, name, group, outputs, window, center
    ("hmm", "HMM", "Probabilistic state-space", STATE_SPACE, 1, False),
    ("hsmm", "HSMM", "Probabilistic state-space", STATE_SPACE, 1, False),
    ("fhmm", "FHMM", "Probabilistic state-space", STATE_SPACE, 1, False),
    ("ar_hmm", "AR-HMM", "Probabilistic state-space", {"power": True, "on": True, "prob": True}, 1, False),
    ("p_hsmm", "P-HSMM", "Probabilistic state-space", STATE_SPACE, 1, False),
    ("crf", "CRF", "Probabilistic state-space", STATE_SPACE, 1, False),
    ("nmf", "NMF", "Sparse / matrix factorization", REGRESSION, 1, False),
    ("dictlearn", "DictLearn", "Sparse / matrix factorization", REGRESSION, 1, False),
    ("sc", "Sparse Coding", "Sparse / matrix factorization", REGRESSION, 1, False),
    ("co", "CO", "Combinatorial / event-based", STATE_SPACE, 1, False),
    ("event", "Event detection", "Combinatorial / event-based", STATE_SPACE, 1, False),
    ("edge", "Edge detection", "Combinatorial / event-based", STATE_SPACE, 1, False),
    ("cpd", "Change-point detection", "Combinatorial / event-based", STATE_SPACE, 1, False),
    ("svm", "SVM", "Classical ML (on/off)", CLASSIFIER, 1, False),
    ("lightgbm", "LightGBM", "Classical ML (on/off)", CLASSIFIER, 1, False),
    ("xgboost", "XGBoost", "Classical ML (on/off)", CLASSIFIER, 1, False),
    ("catboost", "CatBoost", "Classical ML (on/off)", CLASSIFIER, 1, False),
    ("shapelets", "Shapelets", "Classical ML (on/off)", CLASSIFIER, 1, False),
    *[(m.lower().replace("-", "_"), m, "Seq2Point (PyTorch)", REGRESSION, 99, True) for m in (
        "Seq2Point-CNN", "TCN", "LSTM", "GRU", "BiLSTM", "Transformer", "PatchTST", "Informer",
        "Performer", "GNN", "GAT", "CNN-HMM", "TR-RNN", "NS-NILM", "Physics-NILM", "Constraint",
        "DLinear", "NLinear", "TSMixer", "ModernTCN", "KAN")],
    ("dae", "DAE", "Seq2Seq (PyTorch)", REGRESSION, 99, True),
    ("nilmformer", "NILMFormer", "Seq2Seq (PyTorch)", REGRESSION, 129, True),
    ("bert4nilm", "BERT4NILM", "Seq2Seq (PyTorch)", DUAL_HEAD, 99, True),
    ("unet_nilm", "UNet-NILM", "Seq2Seq (PyTorch)", DUAL_HEAD, 99, True),
    ("dqn", "DQN", "Reinforcement learning", REGRESSION, 1, False),
    ("iql", "IQL", "Reinforcement learning", REGRESSION, 1, False),
]

DEVICES = ["ahu", "coffee_maker", "dishwasher", "electric_stove", "fridge", "tumble_dryer", "washing_machine"]

_cache = {}
_cache_lock = threading.Lock()


def _model_file(model_id, settings):
    pattern = settings.get("file_pattern", "{model}_model.pkl")
    return Path(settings["models_dir"]) / settings.get("building", "") / pattern.format(model=model_id)


def _load(model_id, settings):
    """Loads a pickle once and keeps it in memory."""
    with _cache_lock:
        if model_id not in _cache:
            path = _model_file(model_id, settings)
            with open(path, "rb") as f:
                artifact = pickle.load(f)  # needs nilm_framework on sys.path for PyTorch modules
            _cache[model_id] = artifact
        return _cache[model_id]


def _thresholds():
    """On/off threshold per device in watts."""
    # TODO: return {d: cfg.get_on_threshold(d) for d in DEVICES} from your framework config.
    return {d: 10.0 for d in DEVICES}


def list_models(settings):
    thresholds = _thresholds()
    result = []
    for model_id, name, group, outputs, window, center in MODELS:
        exists = _model_file(model_id, settings).exists()
        result.append({
            "id": model_id,
            "name": name,
            "group": group,
            "needsReactive": True,
            "devices": DEVICES,
            "outputs": outputs,
            "window": window,
            "center": center,
            "thresholds": thresholds,
            "trained": True,
            "available": exists,
            "reason": None if exists else f"{_model_file(model_id, settings).name} not found",
        })
    return result


def _framework_input(frame):
    """The aggregate as the framework expects it: 1-minute rows with its P/Q column names."""
    # TODO: use cfg.P_COLUMN / cfg.Q_COLUMN from your framework config.
    return frame.rename(columns={"P": "Active Power", "Q": "Reactive Power"})


def predict(model_id, frame, settings):
    artifact = _load(model_id, settings)
    group = next(m[2] for m in MODELS if m[0] == model_id)
    aggregate = _framework_input(frame)

    if group in ("Probabilistic state-space", "Combinatorial / event-based", "Sparse / matrix factorization"):
        # Pickle holds e.g. {"model": GaussianHMM, "scaler": StandardScaler, "n_states": ..., ...}.
        # TODO: call the framework's decode step, e.g.
        #   X = prepare_markov_input(aggregate, freq="1min")          # core/markov_shared.py
        #   states = artifact["model"].predict(artifact["scaler"].transform(X))
        #   per_device = <your signature matching>(states, artifact)  # -> {device: (power, on)}
        raise NotImplementedError(f"{model_id}: decode step not filled in yet (see TODO in the adapter)")

    if group == "Classical ML (on/off)":
        # Pickle holds {"models": {device: fitted classifier}, "feat_scaler": StandardScaler, ...}.
        # TODO: features = extract_features(aggregate)                 # gradient_boosting/_shared.py
        #       Xs = artifact["feat_scaler"].transform(features)
        #       prob = {d: m.predict_proba(Xs)[:, 1] for d, m in artifact["models"].items()}
        raise NotImplementedError(f"{model_id}: feature step not filled in yet (see TODO in the adapter)")

    # Neural / RL models: per device {"model": nn.Module, "mean_x": ..., "std_x": ...}.
    # TODO: build sliding windows of [P, Q] (window length from MODELS, padded at the
    #       edges), normalise with (x - mean_x) / std_x, run the module under
    #       torch.no_grad() on CPU and undo the output normalisation, e.g. with
    #       the framework function used at test time in seq2point_shared.py.
    raise NotImplementedError(f"{model_id}: inference step not filled in yet (see TODO in the adapter)")


def to_result(n, power=None, on=None, prob=None, thresholds=None):
    """
    Helper to build the return value of predict():
      power/on/prob: {device: array of length n} (any of them may be None).
    If only power is known, on/off is derived from the thresholds.
    """
    devices = set(power or {}) | set(on or {}) | set(prob or {})
    out = {}
    for d in devices:
        p = None if power is None or d not in power else np.asarray(power[d], dtype=float)
        o = None if on is None or d not in on else np.asarray(on[d], dtype=float)
        if o is None and p is not None and thresholds:
            o = (p > thresholds.get(d, 10.0)).astype(float)
        pr = None if prob is None or d not in prob else np.asarray(prob[d], dtype=float)
        out[d] = {k: (None if v is None else v.tolist()) for k, v in (("power", p), ("on", o), ("prob", pr))}
    return out
