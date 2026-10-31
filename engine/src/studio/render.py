#!/usr/bin/env python3
"""Render a performance (from src/score/derive.mjs) to stems, a mix and a master.

Usage: python3 -I src/studio/render.py performance.json OUT_DIR

Writes OUT_DIR/stems/<track>.wav, OUT_DIR/master.wav and prints a JSON report
(render time per stem, loudness, true peak, low-end mono check).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from fx import riser  # noqa: E402
from mix import db_to_gain, delay_bus, master, process_stem, reverb_bus  # noqa: E402
from surge import shared_surge  # noqa: E402

SAMPLE_RATE = 44100
TAIL_SECONDS = 4.0
SOUNDFONT = Path(__file__).resolve().parents[2] / "assets" / "downloads" / "GeneralUser-GS.sf2"
DRUM_CHANNEL = 9
PALETTE = json.loads((HERE.parent / "score" / "palette.json").read_text())["sounds"]


def write_midi(path: Path, notes: list[dict], bpm: float, program: int, drums: bool) -> None:
    ticks = 960
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    channel = DRUM_CHANNEL if drums else 0
    track.append(mido.Message("program_change", program=program, channel=channel, time=0))
    events = []
    for n in notes:
        start = round(n["t"] * ticks)
        end = max(start + 1, round((n["t"] + n["d"]) * ticks))
        events.append((start, 1, mido.Message("note_on", note=int(n["m"]), velocity=int(n["v"]), channel=channel)))
        events.append((end, 0, mido.Message("note_off", note=int(n["m"]), velocity=0, channel=channel)))
    events.sort(key=lambda e: (e[0], e[1]))
    now = 0
    for tick, _, message in events:
        track.append(message.copy(time=tick - now))
        now = tick
    midi = mido.MidiFile(ticks_per_beat=ticks)
    midi.tracks.append(track)
    midi.save(path)


def render_fluidsynth(notes, bpm, program, drums, seconds) -> np.ndarray:
    if not SOUNDFONT.exists():
        raise FileNotFoundError(f"{SOUNDFONT} is missing: run tools/assets/fetch.sh")
    with tempfile.TemporaryDirectory() as tmp:
        mid, wav = Path(tmp) / "part.mid", Path(tmp) / "part.wav"
        write_midi(mid, notes, bpm, program, drums)
        subprocess.run(
            ["fluidsynth", "-ni", "-q", "-F", str(wav), "-r", str(SAMPLE_RATE), "-g", "0.5", str(SOUNDFONT), str(mid)],
            check=True,
            capture_output=True,
        )
        audio, _ = sf.read(wav, dtype="float32", always_2d=True)
    audio = audio.T
    n = int(seconds * SAMPLE_RATE)
    return np.pad(audio, ((0, 0), (0, max(0, n - audio.shape[1]))))[:, :n]


def fit_length(audio: np.ndarray, n: int) -> np.ndarray:
    """Pad or trim to exactly n samples: engines round the song length differently."""
    return np.pad(audio, ((0, 0), (0, max(0, n - audio.shape[1]))))[:, :n].astype(np.float32)


def render_track(track: dict, bpm: float, seconds: float) -> np.ndarray:
    sound = PALETTE.get(track["sound"])
    if sound is None:
        raise KeyError(f"unknown sound '{track['sound']}'")
    if sound["engine"] == "surge":
        surge = shared_surge()
        surge.load_patch(sound["patch"])
        return surge.render(track["notes"], seconds, SAMPLE_RATE, bpm)
    if sound["engine"] in ("gm", "gmdrums"):
        return render_fluidsynth(track["notes"], bpm, sound["program"], sound["engine"] == "gmdrums", seconds)
    if sound["engine"] == "synth":
        out = np.zeros((2, int(seconds * SAMPLE_RATE)), dtype=np.float32)
        beat = 60.0 / bpm
        for n in track["notes"]:
            start = int(n["t"] * beat * SAMPLE_RATE)
            sweep = riser(n["d"] * beat, SAMPLE_RATE) * (n["v"] / 127)
            end = min(out.shape[1], start + sweep.shape[1])
            out[:, start:end] += sweep[:, : end - start]
        return out
    raise ValueError(f"unknown engine {sound['engine']}")


def main() -> None:
    perf = json.loads(Path(sys.argv[1]).read_text())
    out_dir = Path(sys.argv[2])
    (out_dir / "stems").mkdir(parents=True, exist_ok=True)
    started = time.time()
    bpm = perf["bpm"]
    beat = 60.0 / bpm
    seconds = perf["totalBeats"] * beat + TAIL_SECONDS
    n = int(seconds * SAMPLE_RATE)
    kicks = [k * beat for k in perf["kicks"]]

    dry = np.zeros((2, n), dtype=np.float32)
    reverb_send = np.zeros_like(dry)
    delay_send = np.zeros_like(dry)
    stems = {}
    for track_id, track in perf["tracks"].items():
        t0 = time.time()
        raw = fit_length(render_track(track, bpm, seconds), n)
        render_s = time.time() - t0
        role = track["role"]
        automation = [
            (int(a["t0"] * beat * SAMPLE_RATE), int(a["t1"] * beat * SAMPLE_RATE), a["from"], a["to"])
            for a in perf["automation"]
            if a["part"] == track_id
        ]
        trim = PALETTE[track["sound"]].get("level", 0.0)
        processed, measured = process_stem(raw, SAMPLE_RATE, role, track.get("mix", {}), trim, automation, kicks, beat)
        sf.write(out_dir / "stems" / f"{track_id}.wav", processed.T, SAMPLE_RATE, subtype="PCM_16")
        dry += processed
        reverb_send += processed * track.get("mix", {}).get("reverb", 0.0)
        delay_send += processed * track.get("mix", {}).get("delay", 0.0)
        stems[track_id] = {
            "sound": track["sound"],
            "notes": len(track["notes"]),
            "render_s": round(render_s, 1),
            "raw_lufs": round(measured, 1),
        }

    t0 = time.time()
    wet = reverb_bus(reverb_send, SAMPLE_RATE) * db_to_gain(-6) + delay_bus(delay_send, SAMPLE_RATE, beat) * db_to_gain(
        -8
    )
    mastered, levels = master(dry + wet, SAMPLE_RATE)
    sf.write(out_dir / "master.wav", mastered.T, SAMPLE_RATE, subtype="PCM_24")
    report = {
        "seconds": round(seconds, 1),
        "stems": stems,
        "master": levels,
        "timing_s": {"mix_and_master": round(time.time() - t0, 1), "total": round(time.time() - started, 1)},
    }
    print(json.dumps(report))


if __name__ == "__main__":
    main()
