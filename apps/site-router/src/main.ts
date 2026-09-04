import { createAdminPool, GcsStorage, LocalFsStorage } from "@deedwell/database";
import { buildSiteRouter } from "./router.js";

async function main(): Promise<void> {
  const app = buildSiteRouter({
    adminPool: createAdminPool(),
    // Same storage rule as the API: releases live in the bucket on Cloud Run
    // and on local disk in dev, so a release built by one is served by the other.
    storage: process.env.STORAGE_BUCKET
      ? new GcsStorage(process.env.STORAGE_BUCKET)
      : new LocalFsStorage(process.env.DATA_DIR ?? "./.data"),
  });
  // Cloud Run hands the port over as PORT; the dev default stays.
  const port = Number(process.env.PORT ?? process.env.SITE_ROUTER_PORT ?? 8788);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Deedwell Site Router listening on :${port}`);
}

main().catch((err) => {
  console.error("Site Router failed to start:", err);
  process.exit(1);
});
