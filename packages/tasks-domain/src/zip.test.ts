import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.js";

describe("zip", () => {
  it("writes an archive that unzip accepts, de-duplicating names", () => {
    const zip = buildZip([
      { name: "report.md", data: Buffer.from("# Hi\n") },
      { name: "report.md", data: Buffer.from("# Again\n") },
      { name: "img/a.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "dwzip-"));
    writeFileSync(join(dir, "t.zip"), zip);
    const listing = execFileSync("unzip", ["-l", join(dir, "t.zip")]).toString();
    expect(listing).toContain("report.md");
    expect(listing).toContain("report-1.md");
    expect(listing).toContain("img/a.png");
    execFileSync("unzip", ["-tq", join(dir, "t.zip")]);
  });
});
