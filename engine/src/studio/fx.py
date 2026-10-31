"""Effects generated in code: noise risers. Deterministic (fixed seed)."""

from __future__ import annotations

import numpy as np
from pedalboard import HighpassFilter, LowpassFilter

BLOCK = 1024


def riser(seconds: float, sample_rate: int, seed: int = 7) -> np.ndarray:
    """White noise whose band and level sweep upward, ending at full level. Stereo (2, n)."""
    n = int(seconds * sample_rate)
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal((2, n)).astype(np.float32) * 0.3
    out = np.zeros_like(noise)
    low, high = LowpassFilter(400.0), HighpassFilter(80.0)
    for start in range(0, n, BLOCK):
        progress = start / max(1, n - 1)
        low.cutoff_frequency_hz = float(400.0 * (12000.0 / 400.0) ** progress)
        high.cutoff_frequency_hz = float(80.0 * (2000.0 / 80.0) ** progress)
        block = noise[:, start : start + BLOCK]
        out[:, start : start + BLOCK] = high(low(block, sample_rate, reset=False), sample_rate, reset=False)
    envelope = np.linspace(0.0, 1.0, n, dtype=np.float32) ** 2.5
    fade = min(n, int(0.02 * sample_rate))
    envelope[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return out * envelope
