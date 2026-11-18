/** Balance the Node 22 quick tier using measured file durations. */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";

/** Timing inputs measured and rounded in seconds. */
interface Timings {
  setupSeconds: number;
  unmeasuredFileSeconds: number;
  fileSeconds: Record<string, number>;
}

/** A test file and its estimated time on one worker. */
interface WeightedFile {
  path: string;
  seconds: number;
}

/** A shard's file queue and projected test time before job overhead. */
interface Shard {
  files: WeightedFile[];
  seconds: number;
}

const shardCount = 3;
const workers = 4;
const timings = JSON.parse(readFileSync(new URL("./quick-shard-timings.json", import.meta.url), "utf8")) as Timings;
const files = globSync("test/*.test.ts").sort().map(path => ({
  path,
  seconds: timings.fileSeconds[path] ?? timings.unmeasuredFileSeconds,
}));
const shards: Shard[] = Array.from({ length: shardCount }, () => ({ files: [], seconds: 0 }));

/** Model Node's filename-sorted queue, with each file starting on the first free worker. */
function estimatedSeconds(files: WeightedFile[]): number {
  const byPath = new Map(files.map(file => [file.path, file.seconds]));
  const lanes = Array<number>(workers).fill(0);
  for (const path of [...byPath.keys()].sort()) {
    const firstFree = lanes.indexOf(Math.min(...lanes));
    lanes[firstFree] += byPath.get(path)!;
  }
  return Math.max(...lanes);
}

for (const file of files.sort((left, right) => right.seconds - left.seconds)) {
  // Place heavy files first. Compare finish times after insertion because a
  // heavy file queued late can dominate even a shard with a small total weight.
  const candidates = shards.map(shard => ({ shard, seconds: estimatedSeconds([...shard.files, file]) }));
  candidates.sort((left, right) => left.seconds - right.seconds || left.shard.seconds - right.shard.seconds);
  const next = candidates[0];
  next.shard.files.push(file);
  next.shard.seconds = next.seconds;
}

const requested = process.argv[2];
if (requested === undefined) {
  console.log(JSON.stringify(shards.map((shard, index) => ({
    shard: index + 1,
    estimatedSeconds: shard.seconds + timings.setupSeconds,
    files: shard.files.map(file => file.path).sort(),
  })), null, 2));
} else {
  const shard = shards[Number(requested) - 1];
  if (!shard?.files.length) throw new Error(`No test files assigned to quick shard ${requested}`);
  execFileSync(process.execPath, ["--test", "--test-reporter=tap", `--test-concurrency=${workers}`, ...shard.files.map(file => file.path)], {
    stdio: "inherit",
  });
}
