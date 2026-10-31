"""Headless Surge XT through Pedalboard, with factory-patch loading.

Pedalboard exposes a hosted VST3's state as JUCE's "VC2!" + XML wrapper whose
<IComponent> holds the plugin's own state in JUCE's base64 variant. For Surge
that state is the same patch chunk a factory .fxp file holds from byte 60 on
(the "sub3" header), so loading a patch means swapping that chunk in.
See results/render-benchmark.md.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import mido
import numpy as np
from pedalboard import load_plugin

SURGE_VST3 = Path("/usr/lib/vst3/Surge XT.vst3")
PATCH_ROOTS = (Path("/usr/share/surge-xt/patches_factory"), Path("/usr/share/surge-xt/patches_3rdparty"))
FXP_PATCH_OFFSET = 60
_JUCE_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"


def _juce_b64_decode(text: str) -> bytes:
    size_text, data = text.split(".", 1)
    out = bytearray(int(size_text))
    bit = 0
    for char in data:
        value = _JUCE_B64.index(char)
        for k in range(6):
            if value & (1 << k):
                byte, offset = divmod(bit, 8)
                if byte < len(out):
                    out[byte] |= 1 << offset
            bit += 1
    return bytes(out)


def _juce_b64_encode(data: bytes) -> str:
    bits = len(data) * 8
    chars = []
    for i in range((bits + 5) // 6):
        value = 0
        for k in range(6):
            bit = i * 6 + k
            if bit < bits and data[bit // 8] & (1 << (bit % 8)):
                value |= 1 << k
        chars.append(_JUCE_B64[value])
    return f"{len(data)}." + "".join(chars)


def resolve_patch(name: str) -> Path:
    """'Pads/MKS-70 Warm Pad' or 'Inigo Kennedy/.../Pad Basics' -> .fxp path."""
    wanted = Path(name)
    for root in PATCH_ROOTS:
        if (root / f"{name}.fxp").exists():
            return root / f"{name}.fxp"
    hits = sorted(
        hit
        for root in PATCH_ROOTS
        for hit in root.rglob(f"{wanted.name}.fxp")
        if all(part in hit.parts for part in wanted.parts[:-1])
    )
    if not hits:
        raise FileNotFoundError(f"Surge patch '{name}' not found")
    return hits[0]


class Surge:
    """One Surge XT instance. Surge allows one instance per plugin load."""

    def __init__(self) -> None:
        self.plugin = load_plugin(str(SURGE_VST3))
        state = bytes(self.plugin.raw_state)
        size = int.from_bytes(state[4:8], "little")
        self._xml = state[8 : 8 + size].decode()

    def load_patch(self, name: str) -> None:
        chunk = resolve_patch(name).read_bytes()[FXP_PATCH_OFFSET:]
        xml = re.sub(
            r"<IComponent>[^<]*</IComponent>",
            lambda _: f"<IComponent>{_juce_b64_encode(chunk)}</IComponent>",
            self._xml,
        ).encode()
        self.plugin.raw_state = b"VC2!" + len(xml).to_bytes(4, "little") + xml
        # Surge applies a new patch on its next audio block; render a moment of
        # silence so the first real note isn't swallowed by the switch.
        self.plugin([], duration=0.25, sample_rate=44100, num_channels=2, reset=False)

    def loaded_patch_name(self) -> str:
        state = bytes(self.plugin.raw_state)
        xml = state[8 : 8 + int.from_bytes(state[4:8], "little")].decode()
        chunk = _juce_b64_decode(re.search(r"<IComponent>([^<]*)</IComponent>", xml).group(1))
        match = re.search(rb'<meta name="([^"]*)"', chunk)
        return match.group(1).decode() if match else ""

    def render(self, notes: list[dict], seconds: float, sample_rate: int, bpm: float) -> np.ndarray:
        """notes: [{t, d (beats), m, v}] -> stereo float32 array (2, n)."""
        beat = 60.0 / bpm
        messages = []
        for n in notes:
            start = n["t"] * beat
            messages.append(mido.Message("note_on", note=int(n["m"]), velocity=int(n["v"]), time=start))
            messages.append(
                mido.Message("note_off", note=int(n["m"]), velocity=0, time=start + max(0.01, n["d"] * beat))
            )
        messages.sort(key=lambda m: (m.time, m.type == "note_on"))
        return self.plugin(messages, duration=seconds, sample_rate=sample_rate, num_channels=2, reset=True)


@lru_cache(maxsize=1)
def shared_surge() -> Surge:
    return Surge()
