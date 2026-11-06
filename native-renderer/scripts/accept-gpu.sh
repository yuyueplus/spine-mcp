#!/usr/bin/env bash
set -euo pipefail
# Run on the target Linux NVIDIA host after build.sh. No editor or remote data store is used.
session="${1:?worker session JSON required}"
hub="${2:?local room-manager JSON required}"
rooms="${3:-1}"
seconds="${4:-86400}"
output="${5:?NEW report directory required}"
test "$(uname -s)" = Linux
test ! -e "$output"
nvidia-smi
mkdir -p "$(dirname "$output")"
smoke="${output}-smoke"
mkdir "$smoke"
python3 - "$session" "$smoke" <<'PY'
import json,sys
from pathlib import Path
source=Path(sys.argv[1]).resolve()
c=json.loads(source.read_text())
for field in ['skeleton','atlas','shaders']:
 if c.get(field):c[field]=str((source.parent/c[field]).resolve())
for track in c.get('audio',[]):track['file']=str((source.parent/track['file']).resolve())
c.pop('shaders',None)
c.update(frames=60,paced=True,pixelFormat='nv12',renderer='vulkan',queueFrames=2,verification='full')
c['encoder']={'codec':'h264_nvenc','bitrateKbps':c.get('encoder',{}).get('bitrateKbps',6000)}
Path(sys.argv[2],'session.json').write_text(json.dumps(c,indent=2))
PY
export SBGFX_TEST_SESSION="$smoke/session.json"
export SBGFX_TEST_LIBRARY="$(pwd)/build/bin/Release/libspine-bgfx.so"
export SBGFX_TEST_RENDERER=vulkan
export SBGFX_TEST_FFMPEG=ffmpeg
export SBGFX_TEST_FFPROBE=ffprobe
export SBGFX_TEST_HARDWARE_ENCODER=h264_nvenc
go test ./worker -run 'TestRealGPUConvertsNV12OnGPU|TestRealAudioMixAndQueuedEncoding|TestRealHardwareEncoderProbe' -v | tee "$smoke/gpu-tests.log"
build/bin/Release/spine-worker -config "$smoke/session.json" -output "$smoke/probe.mp4" -report "$smoke/probe.json"
build/bin/Release/spine-soak -hub "$hub" -session "$smoke/session.json" -output "$output" -rooms "$rooms" -seconds "$seconds" -require-hardware=true > "$smoke/soak.log" 2>&1
cat "$output/acceptance.json"
