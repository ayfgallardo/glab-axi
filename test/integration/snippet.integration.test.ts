/**
 * Integration tests for snippet edit operations.
 *
 * These tests drive the real `snippetCommand` router against a real GitLab
 * project snippet, so they require:
 *   - `glab` installed and authenticated against the target GitLab instance
 *   - Network access
 *   - GLAB_AXI_INTEGRATION_REPO set to a namespace/project the token can write to
 *
 * Gate: run only when SNIPPET_INTEGRATION=1 is set in the environment.
 * Run locally: SNIPPET_INTEGRATION=1 GLAB_AXI_INTEGRATION_REPO=group/project \
 *   pnpm test test/integration/snippet.integration.test.ts
 *
 * These go THROUGH `snippetCommand` (not hand-built glabApiJson calls) so they
 * exercise glab-axi's own flag routing end-to-end against a real GitLab
 * instance, matching the rationale of the gist integration suite this replaces
 * (see git history: test/integration/gist.integration.test.ts).
 *
 * Only the stdin *source* is mocked (`readStdin`/`isStdinTTY`): the content a
 * caller would pipe is supplied via the mock, while routing and the real glab
 * invocation stay live.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { glabApiJson, glabApiText } from "../../src/glab.js";
import { snippetCommand } from "../../src/commands/snippet.js";
import { isStdinTTY, readStdin } from "../../src/stdin.js";
import type { RepoContext } from "../../src/context.js";

vi.mock("../../src/stdin.js", () => ({
  isStdinTTY: vi.fn(() => false),
  readStdin: vi.fn(async () => ""),
}));

const mockedReadStdin = vi.mocked(readStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);

const RUN = process.env["SNIPPET_INTEGRATION"] === "1";
const repoPath = process.env["GLAB_AXI_INTEGRATION_REPO"];

interface SnippetResponse {
  id: number;
  title: string;
  description: string | null;
}

async function createSnippet(ctx: RepoContext): Promise<number> {
  const created = await glabApiJson<SnippetResponse>("projects/:id/snippets", {
    ctx,
    method: "POST",
    fields: {
      title: "glab-axi integration test scratch",
      visibility: "private",
      "files[0][file_path]": "notes.txt",
      "files[0][content]": "original content",
    },
  });
  return created.id;
}

async function fetchSnippetContent(
  ctx: RepoContext,
  id: number,
): Promise<string> {
  return glabApiText(`projects/:id/snippets/${id}/raw`, { ctx });
}

async function deleteSnippet(ctx: RepoContext, id: number): Promise<void> {
  await glabApiText(`projects/:id/snippets/${id}`, {
    ctx,
    method: "DELETE",
  });
}

describe.skipIf(!RUN)(
  "snippet edit — integration (real glab, real snippet, SNIPPET_INTEGRATION=1)",
  () => {
    const ctx: RepoContext = { fullPath: repoPath ?? "", source: "flag" };
    let snippetId: number;

    beforeEach(() => {
      mockedIsStdinTTY.mockClear();
      mockedReadStdin.mockClear();
      mockedIsStdinTTY.mockReturnValue(false);
      mockedReadStdin.mockResolvedValue("");
    });

    beforeAll(async () => {
      snippetId = await createSnippet(ctx);
      console.log(`Created scratch snippet: ${snippetId}`);
    });

    afterAll(async () => {
      if (snippetId) {
        await deleteSnippet(ctx, snippetId);
        console.log(`Deleted scratch snippet: ${snippetId}`);
      }
    });

    it("replaces file content via a new file through snippetCommand", async () => {
      mockedReadStdin.mockResolvedValue("added from stdin by integration test");
      await snippetCommand(
        ["edit", String(snippetId), "--add", "brand-new.txt", "-"],
        ctx,
      );

      const after = await fetchSnippetContent(ctx, snippetId);
      expect(after).toContain("added from stdin by integration test");
    });

    it("updates the title via snippetCommand", async () => {
      await snippetCommand(
        ["edit", String(snippetId), "--title", "updated by integration test"],
        ctx,
      );

      const after = await glabApiJson<SnippetResponse>(
        `projects/:id/snippets/${snippetId}`,
        { ctx },
      );
      expect(after.title).toBe("updated by integration test");
    });
  },
);
