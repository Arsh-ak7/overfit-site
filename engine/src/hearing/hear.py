#!/usr/bin/env python3
"""The "hearing" report: DSP measurements an agent can read instead of listening.

Usage: python3 -I src/hearing/hear.py SONG.json MIX.wav [STEM_DIR]
Prints JSON. STEM_DIR holds <layer_id>.wav solo renders (optional).

Everything here is measurement, not taste. Ledger's flags are simple heuristics
and are meant to be argued with.
"""

import json
import os
import sys

import librosa
import numpy as np

KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Kessler key profiles
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
BANDS = [("sub", 20, 60), ("low", 60, 250), ("low_mid", 250, 2000), ("high_mid", 2000, 6000), ("air", 6000, 20000)]


def db(x):
    return float(20 * np.log10(max(float(x), 1e-9)))


def estimate_key(chroma_mean):
    best = (None, -2.0)
    scores = []
    for i in range(12):
        for name, prof in (("major", MAJ), ("minor", MIN)):
            r = float(np.corrcoef(chroma_mean, np.roll(prof, i))[0, 1])
            scores.append(r)
            if r > best[1]:
                best = (f"{KEYS[i]} {name}", r)
    scores.sort(reverse=True)
    margin = scores[0] - scores[1]
    return best[0], round(best[1], 3), round(margin, 3)


def band_shares(y, sr):
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=2048)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=4096)
    tot = S.sum() + 1e-12
    return {name: round(float(S[(freqs >= lo) & (freqs < hi)].sum() / tot), 3) for name, lo, hi in BANDS}, S, freqs


def analyse_mix(song, path):
    y_st, sr = librosa.load(path, sr=None, mono=False)
    y = librosa.to_mono(y_st)
    peak = float(np.max(np.abs(y_st)))
    clipped = float(np.mean(np.abs(y_st) >= 0.999))
    rms = float(np.sqrt(np.mean(y**2)))
    bands, _, _ = band_shares(y, sr)
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo = float(np.atleast_1d(librosa.feature.tempo(onset_envelope=onset_env, sr=sr))[0])
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_fft=8192, hop_length=4096)
    key, key_r, key_margin = estimate_key(chroma.mean(axis=1))
    width = 0.0
    if y_st.ndim == 2:
        mid, side = (y_st[0] + y_st[1]) / 2, (y_st[0] - y_st[1]) / 2
        width = float(np.sqrt(np.mean(side**2)) / (np.sqrt(np.mean(mid**2)) + 1e-9))

    bar = 240.0 / song["bpm"]
    sections, t = [], 0.05
    for s in song["sections"]:
        a, b = int(t * sr), int((t + s["bars"] * bar) * sr)
        seg = y[a:b]
        seg_rms = float(np.sqrt(np.mean(seg**2))) if len(seg) else 0.0
        on = librosa.onset.onset_detect(y=seg, sr=sr, units="time") if len(seg) > sr // 4 else []
        ch = (
            librosa.feature.chroma_stft(y=seg, sr=sr, n_fft=8192, hop_length=4096).mean(axis=1)
            if len(seg) > sr
            else np.zeros(12)
        )
        sections.append(
            {
                "name": s["name"],
                "bars": s["bars"],
                "loudness_db": round(db(seg_rms), 1),
                "onsets_per_bar": round(len(on) / s["bars"], 1),
                "_chroma": ch,
            }
        )
        t += s["bars"] * bar
    return {
        "duration_s": round(len(y) / sr, 1),
        "peak_dbfs": round(db(peak), 1),
        "clipped_fraction": round(clipped, 5),
        "loudness_rms_dbfs": round(db(rms), 1),
        "crest_db": round(db(peak) - db(rms), 1),
        "stereo_width": round(width, 2),
        "spectral_centroid_hz": round(centroid),
        "band_energy_share": bands,
        "tempo_heard_bpm": round(tempo, 1),
        "key_heard": key,
        "key_confidence": key_r,
        "key_margin": key_margin,
        "sections": sections,
    }, sr


def analyse_stems(song, stem_dir, mix_rms_db):
    out, spectra = [], {}
    for layer in song["layers"]:
        f = os.path.join(stem_dir, f"{layer['id']}.wav")
        if not os.path.exists(f):
            continue
        y, sr = librosa.load(f, sr=22050, mono=True)
        bands, S, _freqs = band_shares(y, sr)
        frame_rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=1024)[0]
        on = (
            frame_rms > max(1e-4, 0.05 * frame_rms.max())
            if frame_rms.max() > 0
            else np.zeros_like(frame_rms, dtype=bool)
        )
        active = float(np.mean(on))
        # level while the layer is actually playing, so a part that only plays in one section isn't penalised
        rms = float(np.sqrt(np.mean(frame_rms[on] ** 2))) if on.any() else 0.0
        spec = S.mean(axis=1)
        spectra[layer["id"]] = spec / (np.linalg.norm(spec) + 1e-12)
        out.append(
            {
                "id": layer["id"],
                "instrument": layer["instrument"],
                "owner": layer.get("owner"),
                "level_db_vs_mix": round(db(rms) - mix_rms_db, 1),  # while playing
                "main_band": max(bands, key=bands.get),
                "active_fraction": round(active, 2),
            }
        )
    ids = list(spectra)
    for row in out:
        others = [(o, float(spectra[row["id"]] @ spectra[o])) for o in ids if o != row["id"]]
        if others:
            o, sim = max(others, key=lambda x: x[1])
            row["most_overlaps_with"] = o
            row["overlap"] = round(sim, 2)
    return out


def ledger_flags(mix, stems, song):
    flags = []
    if mix["clipped_fraction"] > 0.0005 or mix["peak_dbfs"] > -0.1:
        flags.append(f"Clipping: peak {mix['peak_dbfs']} dBFS. Turn something down.")
    if mix["loudness_rms_dbfs"] < -24:
        flags.append(f"Quiet overall ({mix['loudness_rms_dbfs']} dBFS RMS). Layers may be too soft or too sparse.")
    if mix["band_energy_share"]["low_mid"] > 0.5:
        flags.append("Muddy: over half the energy sits in 250-2000 Hz.")
    if mix["band_energy_share"]["sub"] + mix["band_energy_share"]["low"] > 0.8:
        flags.append("Bottom-heavy: over 80% of the energy is below 250 Hz; little is happening up top.")
    if mix["band_energy_share"]["high_mid"] + mix["band_energy_share"]["air"] < 0.02:
        flags.append("Dull: almost nothing above 2 kHz.")
    if (
        abs(mix["tempo_heard_bpm"] - song["bpm"]) > 4
        and abs(mix["tempo_heard_bpm"] - 2 * song["bpm"]) > 6
        and abs(mix["tempo_heard_bpm"] - song["bpm"] / 2) > 3
    ):
        flags.append(
            f"Pulse unclear: tempo heard as {mix['tempo_heard_bpm']} bpm but the song is set to {song['bpm']}."
        )
    if mix["key_margin"] < 0.03:
        flags.append(f"Key ambiguous (best guess {mix['key_heard']}).")
    secs = mix["sections"]
    same = []
    for i in range(1, len(secs)):
        a, b = secs[i - 1], secs[i]
        if a["_chroma"].any() and b["_chroma"].any():
            sim = float(
                np.dot(a["_chroma"], b["_chroma"])
                / (np.linalg.norm(a["_chroma"]) * np.linalg.norm(b["_chroma"]) + 1e-12)
            )
            if (
                sim > 0.995
                and abs(a["loudness_db"] - b["loudness_db"]) < 1.0
                and abs(a["onsets_per_bar"] - b["onsets_per_bar"]) < 1.0
            ):
                same.append(f"{a['name']}->{b['name']}")
    if same:
        flags.append(f"Adjacent sections that sound nearly identical: {', '.join(same)}.")
    if len(secs) > 2 and max(s["loudness_db"] for s in secs) - min(s["loudness_db"] for s in secs) < 1.5:
        flags.append("Flat energy arc: every section is within 1.5 dB of the others.")
    for s in stems:
        if s["level_db_vs_mix"] < -24:
            flags.append(f"Layer '{s['id']}' is barely audible ({s['level_db_vs_mix']} dB vs mix).")
    cut = None
    if len(stems) >= 3:
        # candidate to cut: overlaps most with another layer and is the quieter of the pair
        cands = [s for s in stems if s.get("overlap", 0) > 0.8]
        if cands:
            worst = max(cands, key=lambda s: (s["overlap"], -s["level_db_vs_mix"]))
            other = next(s for s in stems if s["id"] == worst["most_overlaps_with"])
            quieter = worst if worst["level_db_vs_mix"] <= other["level_db_vs_mix"] else other
            louder = other if quieter is worst else worst
            similarity = round(worst["overlap"] * 100)
            cut = f"'{quieter['id']}' (spectrum {similarity}% similar to '{louder['id']}', and quieter)"
        else:
            q = min(stems, key=lambda s: s["level_db_vs_mix"])
            cut = f"'{q['id']}' (quietest layer, {q['level_db_vs_mix']} dB vs mix)"
    return flags, cut


def main():
    with open(sys.argv[1]) as f:
        song = json.load(f)
    mix, _ = analyse_mix(song, sys.argv[2])
    stems = analyse_stems(song, sys.argv[3], mix["loudness_rms_dbfs"]) if len(sys.argv) > 3 else []
    flags, cut = ledger_flags(mix, stems, song)
    for s in mix["sections"]:
        s.pop("_chroma", None)
    print(json.dumps({"mix": mix, "layers": stems, "ledger": {"flags": flags, "cut_one_thing": cut}}, indent=1))


if __name__ == "__main__":
    main()
