#!/usr/bin/env python3
"""Convert recorded appliance data (.h5) into the format the Enerlyza app reads.

The app runs in the browser and cannot read HDF5 itself, so this script turns
the recordings into small JSON files: one file per local day with one value
per minute (average watts) for every appliance.

Expected input (e.g. the SmartNIALMeter dataset): one HDF5 file per appliance,
named after the appliance, typically in a folder per building:

    <dataset>/building_<x>/ahu.h5
    <dataset>/building_<x>/coffee_maker.h5
    ...

Usage
-----
    # 1. Look at the files: keys, columns, time range, sampling interval
    python tools/import_h5.py --inspect /path/to/building_1

    # 2. Convert (writes data/real/manifest.json and data/real/days/*.json)
    python tools/import_h5.py /path/to/building_1

    # Options
    --map fridge_freezer=fridge   use a different device ID for a file
    --only fridge,dishwasher      import only some appliances
    --column "active power"       which column(s) to use (substring match)
    --start 2023-01-01 --end 2023-03-31
    --timezone Europe/Zurich      local time zone of the days (default)
    --source-tz UTC               time zone of naive timestamps (default UTC)

The output folder data/real/ is listed in .gitignore. Recorded data must never
be committed or uploaded.

Requirements: pandas, tables (PyTables); h5py is optional and only used by
--inspect for files that are not pandas HDF stores.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
except ImportError:  # pragma: no cover - message for the user
    sys.exit("This script needs pandas and PyTables:  pip install pandas tables")

# Device IDs used by the app (see data/devices.json).
def _known_ids() -> set[str]:
    """Device IDs of the app, read from data/devices.json (so a new device only
    has to be added there)."""
    try:
        devices = json.loads((Path(__file__).resolve().parent.parent / "data" / "devices.json").read_text("utf-8"))
        return {d["id"] for d in devices["devices"]}
    except (OSError, KeyError, ValueError):
        return {"ahu", "coffee_maker", "dishwasher", "electric_stove", "fridge",
                "tumble_dryer", "washing_machine", "tv", "lighting"}


KNOWN_IDS = _known_ids()

# Common alternative names -> app device ID.
ALIASES = {
    "air_handling_unit": "ahu",
    "ventilation": "ahu",
    "coffee_machine": "coffee_maker",
    "espresso_machine": "coffee_maker",
    "dish_washer": "dishwasher",
    "stove": "electric_stove",
    "cooker": "electric_stove",
    "electric_cooker": "electric_stove",
    "oven": "electric_stove",
    "fridge_freezer": "fridge",
    "refrigerator": "fridge",
    "dryer": "tumble_dryer",
    "clothes_dryer": "tumble_dryer",
    "washer": "washing_machine",
    "washer_dryer": "washing_machine",
    "television": "tv",
    "light": "lighting",
    "lights": "lighting",
}

H5_SUFFIXES = {".h5", ".hdf5", ".hdf"}
CHUNK_ROWS = 2_000_000


def normalise(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def device_id_for(path: Path, mapping: dict[str, str]) -> str:
    stem = normalise(path.stem)
    if stem in mapping:
        return mapping[stem]
    if stem in KNOWN_IDS:
        return stem
    return ALIASES.get(stem, stem)


def find_files(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for item in inputs:
        p = Path(item).expanduser()
        if p.is_dir():
            files += sorted(f for f in p.rglob("*") if f.suffix.lower() in H5_SUFFIXES)
        elif p.is_file():
            files.append(p)
        else:
            sys.exit(f"Not found: {p}")
    if not files:
        sys.exit("No .h5 files found.")
    return files


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def pick_power_columns(columns, wanted: str | None) -> list:
    """Chooses the column(s) holding active power. Per-phase columns are summed."""
    names = [str(c) for c in columns]
    lower = [n.lower() for n in names]

    if wanted:
        hits = [c for c, n in zip(columns, lower) if wanted.lower() in n]
        if not hits:
            sys.exit(f'No column contains "{wanted}". Columns: {names}')
        return hits

    # 1. Active power (possibly per phase: L1, L2, L3)
    hits = [c for c, n in zip(columns, lower)
            if "active" in n and "power" in n and "reactive" not in n]
    if hits:
        return hits
    # 2. Columns called power / p / watts
    hits = [c for c, n in zip(columns, lower)
            if n in {"power", "p", "w", "watt", "watts", "active_power", "value"}]
    if hits:
        return hits
    # 3. Any column mentioning power but not reactive/apparent/factor
    hits = [c for c, n in zip(columns, lower)
            if "power" in n and not any(x in n for x in ("reactive", "apparent", "factor"))]
    if hits:
        return hits
    sys.exit(f"Could not find a power column. Use --column. Columns: {names}")


def to_time_index(index, source_tz: str) -> pd.DatetimeIndex:
    if not isinstance(index, pd.DatetimeIndex):
        values = np.asarray(index)
        if np.issubdtype(values.dtype, np.number):
            # Unix timestamps in s or ms
            unit = "ms" if np.nanmax(values) > 1e11 else "s"
            index = pd.to_datetime(values, unit=unit, utc=True)
        else:
            index = pd.to_datetime(values, utc=False)
    if index.tz is None:
        index = index.tz_localize(source_tz)
    return index.tz_convert("UTC")


def pick_reactive_columns(columns) -> list:
    """Chooses the column(s) holding reactive power (var). Per-phase columns are summed."""
    hits = [c for c in columns if "reactive" in str(c).lower() and "power" in str(c).lower()]
    if hits:
        return hits
    return [c for c in columns if str(c).lower() in {"q", "var", "vars", "reactive_power"}]


def frame_to_pq(frame: pd.DataFrame, wanted: str | None, source_tz: str, time_col=None) -> pd.DataFrame:
    """Returns a frame with column P (active power, W) and, if present, Q (reactive power, var)."""
    if time_col is not None:
        frame = frame.set_index(time_col)
    elif not isinstance(frame.index, pd.DatetimeIndex):
        for candidate in frame.columns:
            if any(k in str(candidate).lower() for k in ("time", "date", "timestamp")):
                frame = frame.set_index(candidate)
                break
    def total(columns):
        return frame[columns].apply(pd.to_numeric, errors="coerce").sum(axis=1, min_count=1)

    result = pd.DataFrame({"P": total(pick_power_columns(frame.columns, wanted))})
    reactive = pick_reactive_columns(frame.columns)
    if reactive:
        result["Q"] = total(reactive)
    result.index = to_time_index(frame.index, source_tz)
    return result


def read_minutes(path: Path, key: str | None, wanted: str | None, source_tz: str) -> tuple[pd.DataFrame, str]:
    """Returns per-minute averages (UTC index) of P and, if present, Q, and the HDF key used."""
    with pd.HDFStore(path, mode="r") as store:
        keys = store.keys()
        if not keys:
            sys.exit(f"{path.name}: no pandas data found. Run --inspect to see the file layout.")
        key = key or keys[0]
        storer = store.get_storer(key)
        sums, counts = [], []

        def add(values: pd.DataFrame):
            values = values.dropna(subset=["P"])
            if values.empty:
                return
            grouped = values.resample("1min")
            sums.append(grouped.sum())
            counts.append(grouped.count())

        if getattr(storer, "is_table", False):
            for chunk in store.select(key, chunksize=CHUNK_ROWS):
                frame = chunk.to_frame() if isinstance(chunk, pd.Series) else chunk
                add(frame_to_pq(frame, wanted, source_tz))
        else:
            data = store.get(key)
            frame = data.to_frame() if isinstance(data, pd.Series) else data
            add(frame_to_pq(frame, wanted, source_tz))

    if not sums:
        return pd.DataFrame(columns=["P"], dtype=float), key
    total = pd.concat(sums).groupby(level=0).sum()
    count = pd.concat(counts).groupby(level=0).sum()
    minutes = (total / count.replace(0, np.nan)).sort_index()
    return minutes, key


# --------------------------------------------------------------------------
# Inspect
# --------------------------------------------------------------------------

def inspect(files: list[Path], mapping: dict[str, str]) -> None:
    for path in files:
        print(f"\n=== {path}  ->  device id: {device_id_for(path, mapping)}")
        try:
            with pd.HDFStore(path, mode="r") as store:
                for key in store.keys():
                    storer = store.get_storer(key)
                    nrows = getattr(storer, "nrows", None)
                    head = store.select(key, start=0, stop=5) if getattr(storer, "is_table", False) else store.get(key).head()
                    frame = head.to_frame() if isinstance(head, pd.Series) else head
                    print(f"  key {key}  rows={nrows}  format={'table' if getattr(storer, 'is_table', False) else 'fixed'}")
                    print(f"  index: {type(frame.index).__name__}  columns: {[str(c) for c in frame.columns]}")
                    try:
                        print(f"  power column(s) chosen: {[str(c) for c in pick_power_columns(frame.columns, None)]}")
                    except SystemExit as exc:
                        print(f"  {exc}")
                    reactive = pick_reactive_columns(frame.columns)
                    print(f"  reactive power column(s): {[str(c) for c in reactive] or 'none'}")
                    print(frame.to_string(max_cols=8).replace("\n", "\n    "))
                    if isinstance(frame.index, pd.DatetimeIndex) and len(frame.index) > 1:
                        print(f"  first sample: {frame.index[0]}  interval: {frame.index[1] - frame.index[0]}")
                if store.keys():
                    continue
        except Exception as exc:  # not a pandas store
            print(f"  (not a pandas HDF store: {exc})")
        try:
            import h5py
        except ImportError:
            print("  install h5py to list the raw HDF5 layout:  pip install h5py")
            continue
        with h5py.File(path, "r") as f:
            f.visititems(lambda name, obj: print(f"  {name}: {getattr(obj, 'shape', '')} {getattr(obj, 'dtype', '')}"))


# --------------------------------------------------------------------------
# Convert
# --------------------------------------------------------------------------

def convert(args, files: list[Path], mapping: dict[str, str]) -> None:
    only = {normalise(x) for x in args.only.split(",")} if args.only else None
    out = Path(args.out)
    days_dir = out / "days"
    days_dir.mkdir(parents=True, exist_ok=True)

    series: dict[str, pd.Series] = {}  # active power (W) per device
    reactive: dict[str, pd.Series] = {}  # reactive power (var) per device, if recorded
    sources: dict[str, dict] = {}
    for path in files:
        device = device_id_for(path, mapping)
        if only and device not in only:
            continue
        if device in series:
            print(f"  ! {path.name}: device {device} already imported, skipped (use --map)")
            continue
        print(f"Reading {path.name} -> {device} ...", flush=True)
        minutes, key = read_minutes(path, args.key, args.column, args.source_tz)
        if minutes.empty:
            print("  ! no data")
            continue
        if device not in KNOWN_IDS:
            print(f"  ! '{device}' is not a device in data/devices.json - it is stored but not shown")
        series[device] = minutes["P"]
        if "Q" in minutes:
            reactive[device] = minutes["Q"]
        sources[device] = {"file": path.name, "key": key}
        print(f"  {minutes.index[0]} .. {minutes.index[-1]}  ({minutes['P'].notna().sum():,} minutes with data"
              f"{', with reactive power' if 'Q' in minutes else ', no reactive power'})")

    if not series:
        sys.exit("Nothing imported.")

    # Local wall-clock minutes: every day has exactly 1440 slots. On DST days the
    # repeated hour is averaged and the skipped hour stays empty.
    frame = pd.DataFrame({**{f"P:{d}": v for d, v in series.items()}, **{f"Q:{d}": v for d, v in reactive.items()}})
    local = frame.index.tz_convert(args.timezone)
    frame["date"] = local.strftime("%Y-%m-%d")
    frame["minute"] = local.hour * 60 + local.minute
    frame = frame.groupby(["date", "minute"]).mean()

    dates = sorted(frame.index.get_level_values("date").unique())

    # Converting to local time can leave a few minutes on an extra day at the
    # start or end of the recording (e.g. 1 January of the next year). Drop
    # such days when they hold less than a quarter of a day of data.
    filled = frame[[f"P:{d}" for d in series]].notna().any(axis=1).groupby(level="date").sum()
    while len(dates) > 1 and filled.get(dates[0], 0) < 360:
        dates.pop(0)
    while len(dates) > 1 and filled.get(dates[-1], 0) < 360:
        dates.pop()

    if args.start:
        dates = [d for d in dates if d >= args.start]
    if args.end:
        dates = [d for d in dates if d <= args.end]
    if not dates:
        sys.exit("No days in the selected range.")

    # Remove day files of an earlier import that are not part of this one.
    for old in days_dir.glob("*.json"):
        if old.stem not in dates:
            old.unlink()

    devices = list(series)
    coverage = {d: 0 for d in devices}
    for date in dates:
        day = frame.loc[date].reindex(range(1440))
        payload = {"date": date, "devices": {}, "reactive": {}}
        for device in devices:
            values = day[f"P:{device}"].to_numpy()
            coverage[device] += int(np.isfinite(values).sum())
            payload["devices"][device] = [None if not math.isfinite(v) else round(float(v), 1) for v in values]
            if device in reactive:
                q = day[f"Q:{device}"].to_numpy()
                payload["reactive"][device] = [None if not math.isfinite(v) else round(float(v), 1) for v in q]
        (days_dir / f"{date}.json").write_text(json.dumps(payload, separators=(",", ":")))

    manifest = {
        "format": "flow-recorded/2",
        "source": args.label or str(Path(args.inputs[0]).name),
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timezone": args.timezone,
        "resolutionMinutes": 1,
        "start": dates[0],
        "end": dates[-1],
        "days": dates,
        "devices": devices,
        "reactive": [d for d in devices if d in reactive],  # devices with reactive power (var)
        "coverage": {d: round(coverage[d] / (1440 * len(dates)), 3) for d in devices},
        "files": sources,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {len(dates)} days ({dates[0]} .. {dates[-1]}) for {len(devices)} devices to {out}/")
    print("Coverage: " + ", ".join(f"{d} {manifest['coverage'][d]:.0%}" for d in devices))
    print("Reactive power: " + (", ".join(manifest["reactive"]) or "none"))
    print("This folder is in .gitignore - do not commit or upload it.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", help="building folder(s) or .h5 file(s)")
    parser.add_argument("--inspect", action="store_true", help="only print the layout of the files")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "real"))
    parser.add_argument("--map", action="append", default=[], metavar="NAME=ID", help="file name -> device ID")
    parser.add_argument("--only", help="comma-separated device IDs to import")
    parser.add_argument("--key", help="HDF key to read (default: first key in each file)")
    parser.add_argument("--column", help="substring of the power column(s) to use")
    parser.add_argument("--start", help="first day to export (YYYY-MM-DD)")
    parser.add_argument("--end", help="last day to export (YYYY-MM-DD)")
    parser.add_argument("--timezone", default="Europe/Zurich", help="local time zone of the exported days")
    parser.add_argument("--source-tz", default="UTC", help="time zone of timestamps without zone information")
    parser.add_argument("--label", help="name of the data source shown in the app")
    args = parser.parse_args()

    mapping = {}
    for item in args.map:
        name, _, device = item.partition("=")
        mapping[normalise(name)] = device.strip()

    files = find_files(args.inputs)
    if args.inspect:
        inspect(files, mapping)
    else:
        convert(args, files, mapping)


if __name__ == "__main__":
    main()
