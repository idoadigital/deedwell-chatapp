import { loadBrandLogo } from "./brand.js";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { loadMissionProfile, tenantFileKey, uuidv7, withContext } from "@deedwell/database";
import {
  createImageGenerator, generateCampaign, readProviderKey,
  type ContentKind, type OrgContext, type RenderedDesign,
} from "@deedwell/content-domain";
import type { AppContext } from "./app.js";
import { onContentCampaignFinished } from "./proactive/candidates.js";

/**
 * Content Studio campaigns, shared by the /content routes and the chat: a
 * strategy, then a set of generated designs stored as tenant files. Work is
 * detached from whoever asked for it; callers poll the project or await the
 * returned promise.
 */
const MAX_CONCURRENT = Number(process.env.CONTENT_MAX_CONCURRENT ?? 2);
let running = 0;

async function loadOrgContext(client: PoolClient, orgId: string, storage: AppContext["deps"]["storage"]): Promise<OrgContext> {
  // The Mission Profile: facts, brand style, the Knowledge Base notes in
  // full, and document titles (documents are not parsed here, and claiming
  // to have read them would be worse than naming them).
  const profile = await loadMissionProfile(client, storage, orgId);
  return {
    name: profile.orgName,
    mission: profile.facts.find((f) => f.key === "mission")?.value ?? null,
    facts: profile.facts.map((f) => ({ key: f.key, value: f.value })),
    knowledge: [
      ...profile.notes.map((n) => ({ title: n.title, excerpt: n.text })),
      ...profile.documents.map((d) => ({ title: d.filename, excerpt: "" })),
    ],
  };
}

/** The actual work, outside the request. Runs in its own tenant-scoped
 *  transaction because the request's one is long gone by the time it starts. */
async function runCampaign(args: {
  deps: AppContext["deps"];
  orgId: string;
  userId: string;
  id: string;
  kind: ContentKind;
  prompt: string;
}): Promise<void> {
  const { deps, orgId, userId, id, kind, prompt } = args;
  try {
    const { org, logo } = await withContext(deps.appPool, { tenantId: orgId, userId }, async (client) => ({
      org: await loadOrgContext(client, orgId, deps.storage),
      logo: await loadBrandLogo(client, deps.storage),
    }));
    const apiKey = await readProviderKey(deps.appPool, "openai");
    const result = await generateCampaign({
      model: deps.provider,
      images: createImageGenerator({ apiKey }),
      kind,
      prompt,
      org,
      logo,
    });

    await storeDesigns({ deps, orgId, userId, id, designs: result.designs });

    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects SET status = 'ready', strategy = $2, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(result.strategy)]
      )
    );
    void onContentCampaignFinished(deps, { tenantId: orgId, userId, projectId: id, status: "ready" });
  } catch (err) {
    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [id, String((err as Error).message ?? err).slice(0, 500)]
      )
    ).catch(() => {});
    void onContentCampaignFinished(deps, { tenantId: orgId, userId, projectId: id, status: "failed", error: String((err as Error).message ?? err).slice(0, 200) });
    throw err;
  }
}

/** Each design becomes an ordinary tenant file plus a content_assets row. */
async function storeDesigns(args: {
  deps: AppContext["deps"];
  orgId: string;
  userId: string;
  id: string;
  designs: RenderedDesign[];
}): Promise<void> {
  const { deps, orgId, userId, id } = args;
  for (const design of args.designs) {
    const fileId = uuidv7();
    const filename = `${design.caption.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "design"}.png`;
    const storageKey = tenantFileKey(orgId, fileId, filename);
    await deps.storage.put(storageKey, design.bytes);
    await withContext(deps.appPool, { tenantId: orgId, userId }, async (client) => {
      await client.query(
        `INSERT INTO files (id, tenant_id, project_id, filename, mime, size_bytes, sha256, storage_key, created_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
        [fileId, orgId, filename, design.mime, design.bytes.length,
         createHash("sha256").update(design.bytes).digest("hex"), storageKey, userId]
      );
      await client.query(
        `INSERT INTO content_assets (id, tenant_id, content_project_id, file_id, position, prompt, caption, post_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), orgId, id, fileId, design.position, design.prompt, design.caption, design.postText ?? null]
      );
    });
  }
}

/** A further round for a campaign that already has designs. The existing
 *  ones are never touched: a failure here leaves the campaign 'ready' with
 *  what it had, plus the reason, rather than marking good work failed. */
async function runMoreDesigns(args: {
  deps: AppContext["deps"];
  orgId: string;
  userId: string;
  id: string;
  kind: ContentKind;
  prompt: string;
}): Promise<void> {
  const { deps, orgId, userId, id, kind, prompt } = args;
  try {
    const { org, logo, existing } = await withContext(deps.appPool, { tenantId: orgId, userId }, async (client) => ({
      org: await loadOrgContext(client, orgId, deps.storage),
      logo: await loadBrandLogo(client, deps.storage),
      existing: (await client.query(
        "SELECT caption, position FROM content_assets WHERE content_project_id = $1 ORDER BY position",
        [id]
      )).rows as Array<{ caption: string; position: number }>,
    }));
    const apiKey = await readProviderKey(deps.appPool, "openai");
    const result = await generateCampaign({
      model: deps.provider,
      images: createImageGenerator({ apiKey }),
      kind,
      prompt,
      org,
      logo,
      avoid: existing.map((a) => a.caption),
      positionOffset: existing.length ? Math.max(...existing.map((a) => a.position)) + 1 : 0,
    });
    await storeDesigns({ deps, orgId, userId, id, designs: result.designs });
    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects
            SET status = 'ready', updated_at = now(),
                strategy = CASE WHEN strategy IS NULL THEN $2::jsonb
                           ELSE jsonb_set(strategy, '{designs}', coalesce(strategy->'designs', '[]'::jsonb) || ($2::jsonb->'designs')) END
          WHERE id = $1`,
        [id, JSON.stringify(result.strategy)]
      )
    );
  } catch (err) {
    await withContext(deps.appPool, { tenantId: orgId, userId }, (client) =>
      client.query(
        `UPDATE content_projects SET status = 'ready', error = $2, updated_at = now() WHERE id = $1`,
        [id, `Could not generate more: ${String((err as Error).message ?? err).slice(0, 480)}`]
      )
    ).catch(() => {});
    throw err;
  }
}


export function canStartCampaign(): boolean {
  return running < MAX_CONCURRENT;
}

/** Create the project row and start generating. `done` resolves when the
 *  designs are stored (or the project is marked failed). */
export async function startCampaign(
  deps: AppContext["deps"], client: PoolClient,
  args: { orgId: string; userId: string; kind: ContentKind; prompt: string; title?: string | null }
): Promise<{ project: Record<string, unknown>; done: Promise<void> }> {
  const id = uuidv7();
  const title = args.title ?? args.prompt.slice(0, 60);
  await client.query(
    `INSERT INTO content_projects (id, tenant_id, kind, title, prompt, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.orgId, args.kind, title, args.prompt, args.userId]
  );
  const { rows } = await client.query("SELECT * FROM content_projects WHERE id = $1", [id]);
  running += 1;
  const done = runCampaign({ deps, orgId: args.orgId, userId: args.userId, id, kind: args.kind, prompt: args.prompt })
    .catch((err) => console.log(JSON.stringify({ at: "content_campaign_failed", contentProjectId: id, error: String((err as Error).message ?? err).slice(0, 200) })))
    .finally(() => { running -= 1; });
  return { project: rows[0], done };
}

export function startMoreDesigns(deps: AppContext["deps"], args: { orgId: string; userId: string; id: string; kind: ContentKind; prompt: string }): Promise<void> {
  running += 1;
  return runMoreDesigns({ deps, ...args }).finally(() => { running -= 1; });
}
