"""Mixing and mastering: a fixed chain, so A/B comparisons reflect the agents' edits.

Per stem: loudness set to a role target, then high-pass (all but drums and bass),
compression, automation, pan and kick-keyed ducking. Buses: a shared reverb and a
tempo-synced delay. Master: glue compressor, mono below 120 Hz, then loudness to
-14 LUFS with true peak at or below -1 dBTP (Spotify's guidance).
"""

from __future__ import annotations

import numpy as np
import pyloudnorm as pyln
from pedalboard import Compressor, Delay, HighpassFilter, LowpassFilter, Pedalboard, Reverb
from scipy.ndimage import minimum_filter1d
from scipy.signal import resample_poly

TARGET_LUFS = -14.0
TRUE_PEAK_CEILING_DB = -1.0
MONO_BELOW_HZ = 120.0
BLOCK = 1024

# Loudness each role's stem is set to before the mix (LUFS while playing). Starting
# balance from producer folk wisdom: kick/drums loudest, then bass, lead, chords, pads.
ROLE_LUFS = {"drums": -13.0, "bass": -16.0, "lead": -15.0, "counter": -18.0, "chords": -17.0, "fx": -20.0}
ROLE_HIGHPASS_HZ = {"drums": None, "bass": 30.0, "lead": 150.0, "counter": 150.0, "chords": 150.0, "fx": 150.0}
DUCK_RELEASE_BEATS = 0.35


def db_to_gain(db: float) -> float:
    return float(10 ** (db / 20))


def loudness(audio: np.ndarray, sample_rate: int) -> float:
    """Integrated loudness (LUFS) of a (2, n) array; -inf for silence."""
    value = pyln.Meter(sample_rate).integrated_loudness(audio.T)
    return float(value) if np.isfinite(value) else float("-inf")


def true_peak_db(audio: np.ndarray) -> float:
    oversampled = resample_poly(audio, 4, 1, axis=1)
    return float(20 * np.log10(np.abs(oversampled).max() + 1e-12))


def automate_cutoff(audio: np.ndarray, sample_rate: int, curve: list[tuple[int, int, float, float]]) -> np.ndarray:
    """Low-pass sweeps: curve = [(start_sample, end_sample, from 0-1, to 0-1)], 0 = 200 Hz, 1 = 18 kHz."""
    out = audio.copy()
    lowpass = LowpassFilter(18000.0)
    for start in range(0, audio.shape[1], BLOCK):
        position = 1.0
        for s0, s1, a, b in curve:
            if s0 <= start < s1:
                position = a + (b - a) * (start - s0) / max(1, s1 - s0)
        lowpass.cutoff_frequency_hz = float(200.0 * (18000.0 / 200.0) ** position)
        out[:, start : start + BLOCK] = lowpass(audio[:, start : start + BLOCK], sample_rate, reset=False)
    return out


def duck_envelope(
    n: int, sample_rate: int, kick_seconds: list[float], depth_db: float, beat_seconds: float
) -> np.ndarray:
    """Gain curve that dips by depth_db on each kick and recovers: sidechain pumping."""
    gain = np.ones(n, dtype=np.float32)
    if depth_db <= 0 or not kick_seconds:
        return gain
    floor = db_to_gain(-depth_db)
    attack = int(0.004 * sample_rate)
    release = DUCK_RELEASE_BEATS * beat_seconds
    length = int(release * 4 * sample_rate)
    t = np.arange(length) / sample_rate
    shape = 1 - (1 - floor) * np.exp(-t / release)
    shape[:attack] = np.linspace(1.0, shape[attack], attack)
    for k in kick_seconds:
        i = int(k * sample_rate)
        if i >= n:
            continue
        j = min(n, i + length)
        np.minimum(gain[i:j], shape[: j - i], out=gain[i:j])
    return gain


def pan(audio: np.ndarray, position: float) -> np.ndarray:
    """Constant-power pan, -1 left to +1 right."""
    angle = (position + 1) * np.pi / 4
    return np.stack([audio[0] * np.cos(angle) * np.sqrt(2), audio[1] * np.sin(angle) * np.sqrt(2)])


def process_stem(audio, sample_rate, role, mix, trim_db, automation, kick_seconds, beat_seconds):
    """Level, clean up and place one stem. Returns (processed, measured_lufs_before)."""
    measured = loudness(audio, sample_rate)
    if measured == float("-inf"):
        return audio, measured
    target = ROLE_LUFS.get(role, -20.0) + trim_db + mix.get("gain", 0.0)
    audio = audio * db_to_gain(target - measured)
    chain = []
    if ROLE_HIGHPASS_HZ.get(role):
        chain.append(HighpassFilter(ROLE_HIGHPASS_HZ[role]))
    chain.append(Compressor(threshold_db=-18, ratio=3 if role != "drums" else 2, attack_ms=10, release_ms=120))
    audio = Pedalboard(chain)(audio, sample_rate)
    if automation:
        audio = automate_cutoff(audio, sample_rate, automation)
    if mix.get("pan"):
        audio = pan(audio, mix["pan"])
    if mix.get("duck") and role != "drums":
        audio = audio * duck_envelope(audio.shape[1], sample_rate, kick_seconds, mix["duck"], beat_seconds)
    return audio.astype(np.float32), measured


def reverb_bus(send: np.ndarray, sample_rate: int) -> np.ndarray:
    board = Pedalboard(
        [
            Reverb(room_size=0.78, damping=0.45, wet_level=1.0, dry_level=0.0, width=1.0),
            HighpassFilter(250),
            LowpassFilter(9000),
        ]
    )
    return board(send, sample_rate)


def delay_bus(send: np.ndarray, sample_rate: int, beat_seconds: float) -> np.ndarray:
    board = Pedalboard(
        [Delay(delay_seconds=0.75 * beat_seconds, feedback=0.35, mix=1.0), HighpassFilter(300), LowpassFilter(5000)]
    )
    return board(send, sample_rate)


def mono_low_end(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    mid = (audio[0] + audio[1]) / 2
    side = (audio[0] - audio[1]) / 2
    side_low = LowpassFilter(MONO_BELOW_HZ)(side[np.newaxis, :].astype(np.float32), sample_rate)[0]
    side = side - side_low
    return np.stack([mid + side, mid - side]).astype(np.float32)


def brickwall(audio: np.ndarray, ceiling_db: float, release_ms: float = 80.0, block: int = 32) -> np.ndarray:
    """Look-ahead limiter on 4x-oversampled peaks, so true peak stays under the ceiling.

    Gain is computed per block of samples: the reduction each block needs, spread one
    block earlier and later (look-ahead), then released at release_ms. Gain between
    block centres is interpolated, and every neighbour already meets the requirement.
    """
    n = audio.shape[1]
    blocks = -(-n // block)
    padded = np.pad(audio, ((0, 0), (0, blocks * block - n)))
    over = np.abs(resample_poly(padded, 4, 1, axis=1)).max(axis=0)
    peaks = over[: blocks * block * 4].reshape(blocks, block * 4).max(axis=1)
    ceiling = db_to_gain(ceiling_db)
    need_db = np.maximum(0.0, 20 * np.log10(np.maximum(peaks, 1e-12) / ceiling))
    need_db = -minimum_filter1d(-need_db, size=3)  # max over neighbours = look-ahead
    release_step = 20 * np.log10(np.e) * (block / 44100) / (release_ms / 1000)  # dB per block
    smoothed = np.empty_like(need_db)
    level = 0.0
    for i, want in enumerate(need_db):
        level = max(want, level - release_step)
        smoothed[i] = level
    centres = np.arange(blocks) * block + block / 2
    gain_db = np.interp(np.arange(n), centres, smoothed)
    return (audio * (10 ** (-gain_db / 20))).astype(np.float32)


def master(mix: np.ndarray, sample_rate: int) -> tuple[np.ndarray, dict]:
    glued = Pedalboard([Compressor(threshold_db=-14, ratio=2, attack_ms=30, release_ms=250)])(mix, sample_rate)
    glued = mono_low_end(glued, sample_rate)
    ceiling = TRUE_PEAK_CEILING_DB - 0.3
    gain_db = TARGET_LUFS - loudness(glued, sample_rate)
    out = glued
    for _ in range(3):  # limiting lowers loudness a little; push and re-limit
        out = brickwall(glued * db_to_gain(gain_db), ceiling)
        shortfall = TARGET_LUFS - loudness(out, sample_rate)
        if abs(shortfall) < 0.3:
            break
        gain_db += shortfall
    peak = true_peak_db(out)
    if peak > TRUE_PEAK_CEILING_DB:  # interpolation overshoot: trim the last fraction of a dB
        out = out * db_to_gain(TRUE_PEAK_CEILING_DB - peak - 0.05)
    side_low = LowpassFilter(MONO_BELOW_HZ)(((out[0] - out[1]) / 2)[np.newaxis, :].astype(np.float32), sample_rate)
    mid_low = LowpassFilter(MONO_BELOW_HZ)(((out[0] + out[1]) / 2)[np.newaxis, :].astype(np.float32), sample_rate)
    side_vs_mid = 20 * np.log10((np.sqrt((side_low**2).mean()) + 1e-12) / (np.sqrt((mid_low**2).mean()) + 1e-12))
    return out, {
        "lufs": round(loudness(out, sample_rate), 2),
        "true_peak_db": round(true_peak_db(out), 2),
        "low_side_vs_mid_db": round(float(side_vs_mid), 1),
        "limiter_gain_db": round(float(gain_db), 1),
    }
