/** Exercise one exact artifact through real npm/Bun global, runner and local host acquisitions. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { hashJson, type JsonValue } from "../../json-identity.ts";
import { proposerEvolutionConfiguration } from "../../proposer-evolution.ts";
import { IMPROVER_ROLES } from "../../improver-data.ts";

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), "proposer-packed-")); const pin = "2026.11.4";
const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: join(root,"cache"), PM_TELEMETRY_SOURCE_CONTEXT: "test", PM_TELEMETRY_INLINE_FLUSH: "1", GIT_CEILING_DIRECTORIES: root };
/** Execute a bounded subprocess with credential-free arguments and environment. */
function run(argv: readonly string[], cwd: string, environment = childEnv): string { return execFileSync(argv[0],argv.slice(1),{cwd,env:environment,encoding:"utf8",timeout:180_000,stdio:["ignore","pipe","pipe"],maxBuffer:8*1024*1024}); }
const packed = JSON.parse(run(["npm","pack","--ignore-scripts","--json","--pack-destination",root],process.cwd())) as { filename: string; files: { path: string }[] }[];
const artifact = join(root,packed[0].filename); const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
for (const file of ["dist/proposer-program.js","dist/proposer-worker.js","dist/proposer-evolution.js","dist/json-identity.js","examples/proposer-program.json","docs/proposer-programs.md"]) if (!packed[0].files.some((row)=>row.path===file)) throw new Error(`artifact missing ${file}`);
const npmPrefix = join(root,"npm-global"); run(["npm","install","--global","--prefix",npmPrefix,"--ignore-scripts",`@unbrained/pm-cli@${pin}`],root);
const bunPrefix = join(root,"bun-global"); const bunEnv = { ...childEnv, BUN_INSTALL: bunPrefix }; run(["bun","install","--global","--ignore-scripts",`@unbrained/pm-cli@${pin}`],root,bunEnv);
const local = join(root,"local"); mkdirSync(local, { recursive: true }); writeFileSync(join(local,"package.json"),'{"private":true,"type":"module"}'); run(["npm","install","--ignore-scripts",`@unbrained/pm-cli@${pin}`],local);
const hosts = [
  { name:"npm-global", argv:[join(npmPrefix,"bin/pm")], environment:childEnv },
  { name:"bun-global", argv:[join(bunPrefix,"bin/pm")], environment:bunEnv },
  { name:"npx", argv:["npx","--yes","--package",`@unbrained/pm-cli@${pin}`,"pm"], environment:childEnv },
  { name:"bunx", argv:["bunx","--package",`@unbrained/pm-cli@${pin}`,"pm"], environment:childEnv },
  { name:"project-local", argv:[join(local,"node_modules/.bin/pm")], environment:childEnv },
];
const results = [];
for (const host of hosts) {
  const directory = mkdtempSync(join(root,host.name+"-tracker-")); const environment = { ...host.environment, PM_PATH: join(directory,".agents/pm") };
  const invoke = (...args:string[]) => run([...host.argv,...args],directory,environment);
  const actualVersion = invoke("--version").trim(); if (!actualVersion.includes(pin)) throw new Error("Host version drift");
  if (!existsSync(join(directory,".agents/pm/settings.json"))) invoke("init","validation","--defaults","--agent-guidance","skip","--json");
  invoke("package","install",artifact,"--project","--json");
  const config = { ...proposerEvolutionConfiguration(), generations:1,candidates:1,updates:1 }; const file=join(directory,"config.json");writeFileSync(file,JSON.stringify(config));
  const dataset = join(directory,"data");mkdirSync(dataset, { recursive: true });const splits:Record<string,{digest:string;tasks:number}>={};
  for (const role of IMPROVER_ROLES) { const rows=Array.from({length:8},(_,index)=>({id:`${role}-${index}`,prediction_at:index,available_at:index,label:index%2,prefix:{events:["create"],fields:[],words:[index%2],authors:1,elapsed_ms:0}}));const tasks=[{id:`${role}-task`,repo:`public-fixture/${role}`,commit:"a".repeat(40),target:"issue-type",cutoff:4,threshold_ms:null,train:rows.slice(0,4),evaluation:rows.slice(4)}];writeFileSync(join(dataset,`${role}.json`),JSON.stringify(tasks));splits[role]={tasks:1,digest:hashJson(tasks as unknown as JsonValue)}; }
  const record={format:"pm-rl/improver-dataset/1",seed:0,sources:IMPROVER_ROLES.map(role=>({role,repo:`public-fixture/${role}`,commit:"a".repeat(40)})),splits,omitted:[]};writeFileSync(join(dataset,"improver-dataset.json"),JSON.stringify({...record,digest:hashJson(record as unknown as JsonValue)}));
  const body='```json\n'+JSON.stringify({permitted_promotions:100,meta_budget:{training_samples:1000000,proposal_calls:1000,recipe_promotions:100},resource_budget:{training_steps:100,wall_ms:1_000_000,storage_bytes:1_000_000,compute_units:1_000_000,tokens:0}})+'\n```';
  invoke("create","Decision","Packed acceptance approval","--id","approval","--body",body,"--no-inherit-focus","--json");
  const validated=JSON.parse(invoke("rl","proposer","validate","--file",file,"--json"));if(validated.details.valid!==true)throw new Error("validation failed");
  const started=performance.now(); const result=JSON.parse(invoke("rl","proposer","run","packed","--file",file,"--dataset",dataset,"--approval","approval","--json"));
  const toon=invoke("rl","proposer","run","packed","--file",file,"--dataset",dataset,"--approval","approval");
  if(result.details.generations.length!==1||result.details.generations[0].promoted||!toon.includes("retained"))throw new Error("packed outcome drift");
  const row={host:host.name,actual_version:actualVersion,validated:true,completed:true,replayed:true,fit_count:result.details.budget.fits,compact_json_bytes:Buffer.byteLength(JSON.stringify(result)),toon_bytes:Buffer.byteLength(toon),elapsed_ms:Math.ceil(performance.now()-started)};results.push(row);console.log(JSON.stringify(row));
}
writeFileSync(resolve("docs/proposer-packed-evidence.json"),JSON.stringify({artifact_sha256:digest,host_version:pin,modes:results},null,2)+"\n");
