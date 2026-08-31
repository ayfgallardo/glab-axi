import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { countTokens } from "gpt-tokenizer/model/gpt-4o";

const execFileAsync = promisify(execFile);

const REPO = "geofoncier/geofoncier-back";
const HOST = "git.geofoncier.fr";
const MAX_BUFFER = 10 * 1024 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLAB_AXI_BIN = join(__dirname, "..", "dist", "bin", "glab-axi.js");
const GLAB_BIN = execFileSync("which", ["glab"], { encoding: "utf-8" }).trim();

interface RunResult {
  stdout: string;
  ok: boolean;
}

async function run(
  bin: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: MAX_BUFFER,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return { stdout, ok: true };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return { stdout, ok: false };
  }
}

async function glab(args: string[]): Promise<RunResult> {
  return run(GLAB_BIN, args);
}

async function glabAxi(args: string[]): Promise<RunResult> {
  return run("node", [GLAB_AXI_BIN, ...args], { GITLAB_HOST: HOST });
}

async function glabApi(path: string): Promise<RunResult> {
  return glab(["api", path]);
}

interface ResolvedIds {
  mrIid: string;
  issueIid: string;
  pipelineId: string;
}

async function resolveIds(): Promise<ResolvedIds> {
  const projectPath = encodeURIComponent(REPO);
  const mr = await glabApi(
    `projects/${projectPath}/merge_requests?state=opened&per_page=1`,
  );
  const issue = await glabApi(
    `projects/${projectPath}/issues?state=opened&per_page=1`,
  );
  const pipeline = await glabApi(
    `projects/${projectPath}/pipelines?per_page=1`,
  );
  const mrIid = String(JSON.parse(mr.stdout)[0].iid);
  const issueIid = String(JSON.parse(issue.stdout)[0].iid);
  const pipelineId = String(JSON.parse(pipeline.stdout)[0].id);
  return { mrIid, issueIid, pipelineId };
}

interface Case {
  name: string;
  glabRaw: () => Promise<RunResult>;
  glabAxiRun: () => Promise<RunResult>;
}

function buildCases(ids: ResolvedIds): Case[] {
  const projectPath = encodeURIComponent(REPO);
  return [
    {
      name: "mr list",
      glabRaw: () => glab(["mr", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["mr", "list", "-R", REPO]),
    },
    {
      name: "mr view",
      glabRaw: () => glab(["mr", "view", ids.mrIid, "-R", REPO]),
      glabAxiRun: () => glabAxi(["mr", "view", ids.mrIid, "-R", REPO]),
    },
    {
      name: "ci status",
      glabRaw: () => glab(["ci", "status", "-R", REPO, "--branch", "main"]),
      glabAxiRun: () =>
        glabAxi(["ci", "status", "-R", REPO, "--branch", "main"]),
    },
    {
      name: "ci view",
      glabRaw: async () => {
        const pipeline = await glabApi(
          `projects/${projectPath}/pipelines/${ids.pipelineId}`,
        );
        const jobs = await glabApi(
          `projects/${projectPath}/pipelines/${ids.pipelineId}/jobs`,
        );
        return {
          stdout: pipeline.stdout + jobs.stdout,
          ok: pipeline.ok && jobs.ok,
        };
      },
      glabAxiRun: () => glabAxi(["ci", "view", ids.pipelineId, "-R", REPO]),
    },
    {
      name: "issue list",
      glabRaw: () => glab(["issue", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["issue", "list", "-R", REPO]),
    },
    {
      name: "issue view",
      glabRaw: () => glab(["issue", "view", ids.issueIid, "-R", REPO]),
      glabAxiRun: () => glabAxi(["issue", "view", ids.issueIid, "-R", REPO]),
    },
    {
      name: "release list",
      glabRaw: () => glab(["release", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["release", "list", "-R", REPO]),
    },
    {
      name: "repo view",
      glabRaw: () => glab(["repo", "view", "-R", REPO]),
      glabAxiRun: () => glabAxi(["repo", "view", "-R", REPO]),
    },
    {
      name: "variable list",
      glabRaw: () => glab(["variable", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["variable", "list", "-R", REPO]),
    },
    {
      name: "label list",
      glabRaw: () => glab(["label", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["label", "list", "-R", REPO]),
    },
    {
      name: "snippet list",
      glabRaw: () => glabApi(`projects/${projectPath}/snippets`),
      glabAxiRun: () => glabAxi(["snippet", "list", "-R", REPO]),
    },
    {
      name: "schedule list",
      glabRaw: () => glab(["schedule", "list", "-R", REPO]),
      glabAxiRun: () => glabAxi(["schedule", "list", "-R", REPO]),
    },
    {
      name: "home",
      glabRaw: async () => {
        const user = await glabApi("user");
        const mrs = await glabApi(
          "merge_requests?scope=assigned_to_me&state=opened&per_page=3",
        );
        const issues = await glabApi(
          "issues?scope=assigned_to_me&state=opened&per_page=3",
        );
        const todos = await glabApi("todos?per_page=3");
        return {
          stdout: user.stdout + mrs.stdout + issues.stdout + todos.stdout,
          ok: user.ok && mrs.ok && issues.ok && todos.ok,
        };
      },
      glabAxiRun: () => glabAxi([]),
    },
  ];
}

interface Row {
  name: string;
  glabTokens: number;
  axiTokens: number;
  deltaPct: number;
  note?: string;
}

async function main(): Promise<void> {
  const ids = await resolveIds();
  const cases = buildCases(ids);
  const rows: Row[] = [];

  for (const c of cases) {
    const [rawResult, axiResult] = await Promise.all([
      c.glabRaw(),
      c.glabAxiRun(),
    ]);
    const glabTokens = countTokens(rawResult.stdout);
    const axiTokens = countTokens(axiResult.stdout);
    const deltaPct =
      glabTokens === 0 ? 0 : ((axiTokens - glabTokens) / glabTokens) * 100;
    const note =
      glabTokens === 0 && axiTokens === 0
        ? "paire vide sur ce projet"
        : undefined;
    rows.push({ name: c.name, glabTokens, axiTokens, deltaPct, note });
  }

  const lines: string[] = [];
  lines.push(`| Commande | Tokens glab | Tokens glab-axi | Delta % | Note |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const row of rows) {
    const delta = `${row.deltaPct >= 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%`;
    lines.push(
      `| ${row.name} | ${row.glabTokens} | ${row.axiTokens} | ${delta} | ${row.note ?? ""} |`,
    );
  }
  console.log(lines.join("\n"));

  const sorted = [...rows].map((r) => r.deltaPct).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  console.error(`\nDelta médian: ${median.toFixed(1)}%`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
