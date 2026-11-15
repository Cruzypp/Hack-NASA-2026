# Flight Playback Data Contract

The flight playback consumes a compact JSON document generated from offline
processing of LOFT physiological data sampled at 256 Hz. The console must not
recompute the statistical pipeline.

## Top-level shape

```json
{
  "meta": {
    "hz": 8,
    "window_s": 2,
    "baseline_event": 0,
    "rule": "iqr-robust-z@0.1",
    "source": "LOFT physiological 256Hz -> 8Hz"
  },
  "baseline": {
    "ECG": { "median": 0, "iqr": 0 },
    "GSR": { "median": 0, "iqr": 0 },
    "EEG_FP1": { "median": 0, "iqr": 0 },
    "EEG_Cz": { "median": 0, "iqr": 0 }
  },
  "samples": [
    {
      "t": 0,
      "phase": "prelaunch",
      "cognitive_load": 12.4,
      "alerta_activa": false,
      "z": {
        "ECG": 0.2,
        "GSR": 0.1,
        "EEG_FP1": 0.3,
        "EEG_Cz": 0.1
      }
    }
  ]
}
```

## Invariants

- `meta.hz` is the playback sample rate and is currently `8`.
- `meta.window_s` is the source smoothing window and is currently `2`.
- `meta.baseline_event` identifies the baseline rows in the source data.
- `baseline` contains the median and IQR for every signal present in `samples[*].z`.
- `samples` are ordered by ascending `t`, measured in mission seconds.
- `phase` is a short mission phase label such as `prelaunch`, `launch`, or
  `orbit`.
- `cognitive_load` is the cognitive-load index on a `0` to `100` scale.
- `alerta_activa` is the hysteresis state emitted by the offline processor.
- `z` contains non-negative robust scores by signal. The UI only renders these
  values and does not calculate them.

The canonical example is
[`public/samples/muestra_vuelo.json`](../public/samples/muestra_vuelo.json).
