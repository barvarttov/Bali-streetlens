// Generates fixtures/synthetic_sync.mp4: a 40 s, 25 fps test pattern with the frame number burned in.
// Used to check sync: at any seek point, the frame number the app shows must equal the one in the picture.
// Encoded like a normalized clip (constant fps, keyframe every 1 s, faststart). See docs/schema.md.
// Run: npm run fixture:video   (needs ffmpeg on PATH, or set FFMPEG to its full path)

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const out = join(import.meta.dirname, "..", "..", "fixtures", "synthetic_sync.mp4");
const font = process.platform === "win32" ? "fontfile='C\\:/Windows/Fonts/arialbd.ttf'" : "font=Sans";

const filters = [
  `drawtext=${font}:text='SYNTHETIC TEST VIDEO':x=(w-tw)/2:y=30:fontsize=36:fontcolor=white:box=1:boxcolor=red@0.8:boxborderw=10`,
  `drawtext=${font}:text='frame %{frame_num}':x=(w-tw)/2:y=h-th-40:fontsize=72:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=14`,
].join(",");

const args = [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=40",
  "-vf", filters,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
  "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
  "-movflags", "+faststart",
  out,
];

const result = spawnSync(ffmpeg, args, { stdio: "inherit" });
if (result.error || result.status !== 0) {
  console.error(`ffmpeg failed (${result.error?.message ?? `exit ${result.status}`}). Is ffmpeg installed? Set FFMPEG=<path> if it isn't on PATH.`);
  process.exit(1);
}
console.log(`wrote ${out}`);
