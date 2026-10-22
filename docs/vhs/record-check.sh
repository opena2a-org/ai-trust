#!/usr/bin/env bash
# Renders docs/vhs/check.tape inside the recording container and writes the provenance sidecar.
#
#   env -i PATH="$PATH" HOME="$(mktemp -d)" docs/vhs/record-check.sh
#
# Needs docker, node, npm and git on PATH. Run it with an empty environment, as above. The script
# passes nothing from its own environment into the container, and it refuses to start (exit 2)
# when ANTHROPIC_API_KEY or OPENAI_API_KEY is set, so a render cannot spend on a metered API.
#
# The container (docs/vhs/docker/Dockerfile) carries VHS 0.12.0 with its encode regression patched,
# ffmpeg, ttyd, Chromium, JetBrains Mono, gifsicle, Node 22, procps and ai-trust installed globally,
# so the typed `npx ai-trust ...` runs that build with no download on screen. Which build: when npm
# has the version in package.json, that published version (the sidecar records npmIntegrity and
# prerelease false: a release render, the one the README embeds); otherwise the tarball `npm pack`
# makes from this checkout (the sidecar records packedFromCommit and prerelease true).
# AI_TRUST_RECORD_SOURCE=pack forces the tarball.
#
# The `check` step shows the public registry's live answer; nothing is replayed. The `audit` step
# reads a copy of docs/demo, the sample project. The hostname is `laptop` and HOME is fresh.
# Each step of the tape writes its anchor frame, docs/vhs/check-s<N>.png. After the tape, the same
# container runs the tape's commands once more with NO_COLOR=1 into check-capture.txt (the text
# version of the recording), optimises the GIF, remuxes the MP4 with its index first (faststart),
# and writes check.json (schema demo-sidecar/2). The MP4 stays in docs/vhs/out/, which is not
# committed; the sidecar carries its size and sha256. Last, the README block between
# <!-- demo:check:start --> and <!-- demo:check:end --> is rewritten from the sidecar, so its
# caption names the version and the date of this render.
set -euo pipefail
for key in ANTHROPIC_API_KEY OPENAI_API_KEY; do
  if [ -n "${!key+set}" ]; then
    echo "record-check: $key is set. A recording runs with no metered API key in its environment; unset it and run again." >&2
    exit 2
  fi
done
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKER="${DOCKER:-docker}"
TOOL="ai-trust"
VERSION="$(node -p "require(process.argv[1]).version" "$REPO_ROOT/package.json")"
INTEGRITY=""
if [ "${AI_TRUST_RECORD_SOURCE:-}" != "pack" ]; then
  INTEGRITY="$(npm view "$TOOL@$VERSION" dist.integrity 2>/dev/null || true)"
fi
# The build context is a scratch copy of docs/vhs/docker, so a packed tarball never lands in the tree.
CONTEXT="$(mktemp -d)"
cleanup_context() { rm -rf "$CONTEXT"; }
trap cleanup_context EXIT
cp "$REPO_ROOT/docs/vhs/docker/Dockerfile" "$REPO_ROOT/docs/vhs/docker/vhs-0.12.0-render-context.patch" "$CONTEXT/"
PACKED_FROM=""
PACKED_DIRTY=0
if [ -n "$INTEGRITY" ]; then
  TOOL_SPEC="$TOOL@$VERSION"
  IMAGE="${AI_TRUST_VHS_IMAGE:-ai-trust-vhs:$VERSION}"
else
  (cd "$REPO_ROOT" && npm run build >&2 && npm pack --ignore-scripts --pack-destination "$CONTEXT" >&2)
  TOOL_SPEC="/ctx/$TOOL-$VERSION.tgz"
  [ -f "$CONTEXT/$TOOL-$VERSION.tgz" ] || { echo "record-check: npm pack did not write $TOOL-$VERSION.tgz" >&2; exit 1; }
  PACKED_FROM="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  PACKED_DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- src package.json package-lock.json | wc -l | tr -d ' ')"
  IMAGE="${AI_TRUST_VHS_IMAGE:-ai-trust-vhs:$VERSION-pack}"
fi
FIXTURE_DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- docs/demo | wc -l | tr -d ' ')"
"$DOCKER" build -t "$IMAGE" --build-arg TOOL="$TOOL" --build-arg TOOL_VERSION="$VERSION" --build-arg TOOL_SPEC="$TOOL_SPEC" "$CONTEXT" >&2
mkdir -p "$REPO_ROOT/docs/vhs/out"
"$DOCKER" run --rm --hostname laptop --shm-size=1g \
  -e TOOL="$TOOL" -e EXPECTED_VERSION="$VERSION" -e NPM_INTEGRITY="$INTEGRITY" \
  -e PACKED_FROM="$PACKED_FROM" -e PACKED_DIRTY="$PACKED_DIRTY" -e FIXTURE_DIRTY="$FIXTURE_DIRTY" \
  -v "$REPO_ROOT/docs/vhs":/work/docs/vhs \
  -v "$REPO_ROOT/docs/demo":/work/fixture:ro \
  --entrypoint bash "$IMAGE" -c '
set -euo pipefail
export HOME="$(mktemp -d)"
cp -r /work/fixture /work/demo
cd /work
VERSION="$("$TOOL" --version 2>/dev/null | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1)"
if [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "record-check: the container runs $TOOL $VERSION, package.json says $EXPECTED_VERSION" >&2
  exit 1
fi
# A render that fails part way leaves no sidecar: the old one would describe outputs that are gone.
# The anchor frames go too, so every frame the sidecar names comes from this render.
rm -f docs/vhs/check.json docs/vhs/check-s[0-9]*.png
RAN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_NS="$(date +%s%N)"
vhs docs/vhs/check.tape
WALL_MS="$(( ($(date +%s%N) - STARTED_NS) / 1000000 ))"
gifsicle -O3 --lossy=40 --batch docs/vhs/check.gif
# VHS writes the MP4 index (moov) after the media data (mdat). The remux moves the index to the
# front (faststart), so a browser starts playing the file before all of it has arrived.
ffmpeg -v error -y -i docs/vhs/out/check.mp4 -c copy -movflags +faststart -f mp4 docs/vhs/out/check.faststart.mp4
mv docs/vhs/out/check.faststart.mp4 docs/vhs/out/check.mp4
# Frame census: the full-screen frames are a report streaming into the terminal; how many ticks
# that spans varies with container load, so the sidecar records it per render.
FRAMES_DIR="$(mktemp -d)"
(cd "$FRAMES_DIR" && gifsicle --explode /work/docs/vhs/check.gif -o f >/dev/null 2>&1)
FRAME_CENSUS="$(node docs/vhs/frame-census.mjs "$FRAMES_DIR")"
rm -rf "$FRAMES_DIR"
# The text capture runs exactly what the tape types on screen.
COMMANDS="$(node docs/vhs/tape-commands.mjs docs/vhs/check.tape)"
mapfile -t TYPED < <(node -e "for (const c of JSON.parse(process.argv[1])) console.log(c)" "$COMMANDS")
EXIT_CODES=""
cd /work/demo
{
  for i in "${!TYPED[@]}"; do
    if [ "$i" -gt 0 ]; then echo; fi
    echo "\$ ${TYPED[$i]}"
    NO_COLOR=1 bash -c "${TYPED[$i]}" </dev/null && E=0 || E=$?
    echo "[exit $E]"
    EXIT_CODES="$EXIT_CODES $E"
  done
} > /work/docs/vhs/check-capture.txt 2>&1
cd /work
VHS_VERSION="$(vhs --version 2>/dev/null | head -1 | sed "s/^vhs version //")"
GIF_PX="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 docs/vhs/check.gif)"
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 docs/vhs/out/check.mp4)"
# The sidecar is written to a scratch file and copied into place only when node succeeds.
SIDECAR="$(mktemp)"
cleanup_sidecar() { rm -f "$SIDECAR"; }
trap cleanup_sidecar EXIT
node - "$RAN_AT" "$VERSION" "$GIF_PX" "$DURATION" "$WALL_MS" "$VHS_VERSION" "$FRAME_CENSUS" "$COMMANDS" "$EXIT_CODES" <<"NODE" > "$SIDECAR"
const fs = require("fs"), crypto = require("crypto"), { execFileSync } = require("child_process");
const [ranAtUtc, version, gifPx, duration, wallMs, vhsVersion, frameCensus, commands, exitCodes] = process.argv.slice(2);
const census = JSON.parse(frameCensus);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const size = (f) => fs.statSync(f).size;
const [width, height] = gifPx.split(",").map(Number);
const tape = "docs/vhs/check.tape";
const patch = "docs/vhs/docker/vhs-0.12.0-render-context.patch";
const narration = "docs/vhs/check.narration.json";
const capture = "docs/vhs/check-capture.txt";
const gif = "docs/vhs/check.gif";
const mp4 = "docs/vhs/out/check.mp4";
// What the tape sets, and what it does on screen (outside Hide..Show): the Sleep before each Enter,
// and its steps, each a "# step: <id> <title>" comment and the Screenshot that step takes.
const settings = {};
const steps = [];
const preEnterMs = [];
let hidden = false;
let previous = "";
for (const line of fs.readFileSync(tape, "utf8").split("\n").map((l) => l.trim())) {
  if (line === "" || (line.startsWith("#") && !line.startsWith("# step: "))) continue;
  const set = line.match(/^Set (\w+) (\d+)(?:ms)?$/);
  const step = line.match(/^# step: (\S+)\s*(.*)$/);
  const screenshot = line.match(/^Screenshot (\S+)$/);
  if (set) settings[set[1]] = Number(set[2]);
  else if (line === "Hide") hidden = true;
  else if (line === "Show") hidden = false;
  else if (!hidden && step) steps.push({ id: step[1], title: step[2], anchorFrame: null });
  else if (!hidden && screenshot && steps.length) steps[steps.length - 1].anchorFrame = screenshot[1];
  else if (!hidden && line === "Enter") {
    const sleep = previous.match(/^Sleep ([0-9.]+)(ms|s)?$/);
    preEnterMs.push(sleep ? Number(sleep[1]) * (sleep[2] === "ms" ? 1 : 1000) : 0);
  }
  previous = line;
}
for (const name of ["TypingSpeed", "Columns", "Rows", "Framerate"]) {
  if (!(name in settings)) throw new Error(tape + " sets no " + name);
}
if (new Set(preEnterMs).size !== 1) throw new Error(tape + " holds " + preEnterMs.join(", ") + " ms before its Enters; the sidecar records one hold");
for (const step of steps) {
  if (!step.anchorFrame || !fs.existsSync(step.anchorFrame)) throw new Error("step " + step.id + " wrote no anchor frame in this render");
}
const spoken = JSON.parse(fs.readFileSync(narration, "utf8")).steps.map((s) => s.id).join(",");
if (spoken !== steps.map((s) => s.id).join(",")) throw new Error(narration + " names the steps " + spoken + ", the tape " + steps.map((s) => s.id).join(","));
// The top-level boxes of the MP4 in file order. Faststart puts moov, the index, before mdat.
const boxes = [];
const movie = fs.readFileSync(mp4);
for (let at = 0; at + 8 <= movie.length; ) {
  let length = movie.readUInt32BE(at);
  if (length === 1) length = Number(movie.readBigUInt64BE(at + 8));
  else if (length === 0) length = movie.length - at;
  if (length < 8) throw new Error(mp4 + " has a box of " + length + " bytes at offset " + at);
  boxes.push(movie.toString("latin1", at + 4, at + 8));
  at += length;
}
const faststart = boxes.includes("moov") && boxes.includes("mdat") && boxes.indexOf("moov") < boxes.indexOf("mdat");
if (!faststart) throw new Error(mp4 + " is not faststart: its boxes are " + boxes.join(" "));
// The registry the recorded build asks by default, read from its own help text.
const registryUrl = /--registry-url[\s\S]*?default:\s*"(https?:\/\/[^"]+)"/.exec(execFileSync(process.env.TOOL, ["--help"], { encoding: "utf8" }));
if (!registryUrl) throw new Error("no default registry URL in the --help output");
const build = process.env.NPM_INTEGRITY
  ? { npmIntegrity: process.env.NPM_INTEGRITY }
  : { packedFromCommit: process.env.PACKED_FROM, packedTreeUncommittedChanges: Number(process.env.PACKED_DIRTY) };
// The demo-sidecar/2 keys come first, in the order of that schema; the keys this script wrote
// before it follow.
const out = {
  schema: "demo-sidecar/2",
  surfaceClass: "terminal",
  tool: process.env.TOOL,
  version,
  // A render of the published package is a release render; a tarball packed from a checkout is not.
  prerelease: !process.env.NPM_INTEGRITY,
  script: tape,
  scriptSha256: sha(tape),
  recorder: { name: "vhs", version: vhsVersion, container: "docs/vhs/docker/Dockerfile" },
  commands: JSON.parse(commands),
  steps,
  fixture: "docs/demo, the sample project",
  fixtureSha: sha("/work/demo/package.json"),
  fixtureUncommittedChanges: Number(process.env.FIXTURE_DIRTY),
  ranAtUtc,
  durationSeconds: Number(Number(duration).toFixed(1)),
  outputs: {
    gif: { path: gif, bytes: size(gif), sha256: sha(gif), width, height, frames: census.frames },
    mp4: { path: mp4, bytes: size(mp4), sha256: sha(mp4), committed: false, faststart },
    frames: steps.map((s) => s.anchorFrame),
    capture
  },
  capture,
  narration,
  // minHoldSeconds and maxLineChars are the pace rule: the shortest hold on a step and the longest
  // typed line it allows.
  pace: { typingSpeedMs: settings.TypingSpeed, preEnterHoldMs: preEnterMs[0], minHoldSeconds: 3, maxLineChars: 72 },
  exitCodes: exitCodes.trim().split(/\s+/).map(Number),
  meteredCostUsd: 0,
  tape,
  tapeSha256: sha(tape),
  ...build,
  registryHost: new URL(registryUrl[1]).host,
  fixturePath: "/work/demo",
  hostname: fs.readFileSync("/etc/hostname", "utf8").trim(),
  columns: settings.Columns,
  rows: settings.Rows,
  framerate: settings.Framerate,
  gifsicle: "-O3 --lossy=40 --batch",
  gifFrames: census.frames,
  gifFullScreenFrames: census.fullScreenFrames,
  renderedPixelSize: { width, height },
  wallClockSeconds: Number((Number(wallMs) / 1000).toFixed(1)),
  vhsPatchSha256: sha(patch),
  edits: ["setup not shown"],
  environment: {
    container: "docs/vhs/docker/Dockerfile (Node " + process.versions.node + ", " + process.env.TOOL + " installed globally with --ignore-scripts)",
    vhs: { version: vhsVersion, patch },
    telemetry: "off (OPENA2A_TELEMETRY=off in the container)"
  }
};
console.log(JSON.stringify(out, null, 2));
NODE
cp "$SIDECAR" docs/vhs/check.json
'
# The README embed is rebuilt from the sidecar this render wrote: the GIF, the caption with this
# render's version and date, and the links to the capture and the sidecar.
node - "$REPO_ROOT/README.md" "$REPO_ROOT/docs/vhs/check.json" <<"NODE"
const fs = require("fs");
const [readme, sidecarPath] = process.argv.slice(2);
const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
const lines = fs.readFileSync(readme, "utf8").split("\n");
const start = lines.indexOf("<!-- demo:check:start -->");
const end = lines.indexOf("<!-- demo:check:end -->");
if (start === -1 || end < start) throw new Error("README.md has no <!-- demo:check:start --> ... <!-- demo:check:end --> block");
lines.splice(start + 1, end - start - 1,
  `![ai-trust check on an MCP server, then audit package.json](${sidecar.outputs.gif.path})`,
  "",
  `Recorded with ${sidecar.tool} ${sidecar.version} on ${sidecar.ranAtUtc.slice(0, 10)}`,
  "",
  `[capture](${sidecar.capture}), [provenance](docs/vhs/check.json)`);
fs.writeFileSync(readme, lines.join("\n"));
NODE
echo "rendered: $(cd "$REPO_ROOT" && ls -l docs/vhs/check.gif docs/vhs/out/check.mp4 docs/vhs/check.json docs/vhs/check-capture.txt docs/vhs/check-s[0-9]*.png | awk '{print $5, $NF}' | tr '\n' ';')"
