import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";

// Install FFmpeg with libx264, or set FFMPEG_PATH to its executable.
export function checkEncoder() {
  const encoders = execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true });
  if (!encoders.includes("libx264")) throw new Error("FFmpeg requires the libx264 encoder");
}

export function convertToMp4(source, destination) {
  const pending = destination + ".tmp.mp4";
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", pending
  ], { stdio: "inherit", windowsHide: true });
  // Only replace the published artifact after successful encoding.
  renameSync(pending, destination);
}
