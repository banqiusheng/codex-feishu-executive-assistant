import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("repository contract", () => {
  it("pins the package manager and supported even Node majors", () => {
    expect(pkg.packageManager).toBe("pnpm@10.0.0");
    expect(pkg.engines.node).toBe(
      ">=20.0.0 <21.0.0 || >=22.0.0 <23.0.0 || >=24.0.0 <25.0.0 || >=26.0.0 <27.0.0",
    );
  });

  it("exposes all quality gates", () => {
    expect(Object.keys(pkg.scripts).sort()).toEqual(
      [
        "build",
        "format:check",
        "lint",
        "prebuild",
        "pretest",
        "pretypecheck",
        "test",
        "typecheck",
      ].sort(),
    );
  });

  it("creates the locked contracts workspace package", () => {
    const contractsPkg = JSON.parse(
      readFileSync("packages/contracts/package.json", "utf8"),
    );
    expect(contractsPkg.name).toBe("@executive-assistant/contracts");
    expect(contractsPkg.dependencies).toEqual({ zod: "4.4.3" });
  });
});
