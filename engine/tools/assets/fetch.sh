#!/usr/bin/env bash
# Download the large free assets the studio renderer needs. They aren't committed.
#   - GeneralUser GS 2.0.3 SoundFont (free for any music use; see src/studio/palette.json)
#   - Surge XT 1.3.4 is a system package: install the .deb from
#     https://github.com/surge-synthesizer/releases-xt/releases/tag/1.3.4
set -euo pipefail
cd "$(dirname "$0")/../.."
DEST=assets/downloads
mkdir -p "$DEST"

SF2="$DEST/GeneralUser-GS.sf2"
SF2_SHA256="${SF2_SHA256:-9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe}"
if [[ ! -f "$SF2" ]]; then
  tmp=$(mktemp -d)
  git clone -q --depth 1 https://github.com/mrbumpy409/GeneralUser-GS "$tmp/gugs"
  cp "$tmp/gugs/GeneralUser-GS.sf2" "$SF2"
  cp "$tmp/gugs/documentation/LICENSE.txt" "$DEST/GeneralUser-GS-LICENSE.txt"
  rm -rf "$tmp"
fi
if [[ -n "$SF2_SHA256" ]]; then
  echo "$SF2_SHA256  $SF2" | sha256sum -c -
fi
sha256sum "$SF2"
[[ -e "/usr/lib/vst3/Surge XT.vst3" ]] || echo "Surge XT is not installed: see the comment at the top of this script." >&2
