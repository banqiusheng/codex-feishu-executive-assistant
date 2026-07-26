import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const codesignFixture = vi.hoisted(() => ({
  displayOutput: "",
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const executeCodesign = (arguments_: readonly string[]) => {
    if (arguments_[0] === "--verify") {
      return { stdout: "", stderr: "" };
    }
    if (arguments_[0] === "-d" && arguments_[1] === "-r-") {
      return { stdout: "", stderr: codesignFixture.displayOutput };
    }
    throw new Error("unexpected codesign arguments");
  };
  const execFile = (
    executable: string,
    arguments_: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (executable !== "/usr/bin/codesign") {
      throw new Error("unexpected executable");
    }
    const result = executeCodesign(arguments_);
    queueMicrotask(() => callback(null, result.stdout, result.stderr));
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (executable: string, arguments_: readonly string[]) => {
      if (executable !== "/usr/bin/codesign") {
        throw new Error("unexpected executable");
      }
      return executeCodesign(arguments_);
    },
  });
  return {
    ...actual,
    execFile,
  };
});

import { createInstalledLarkCliRunnerFactory } from "../src/installed-lark-cli.js";

const temporaryRoots: string[] = [];
const RELEASE_VERIFICATION_TEST_TIMEOUT_MS = 15_000;

function createFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ea-installed-lark-cli-")),
  );
  temporaryRoots.push(root);
  const releaseRoot = join(root, "lark-cli-1.0.72");
  const privateBin = join(releaseRoot, "private-bin");
  const executable = join(privateBin, "lark-cli");
  const homeDirectory = join(root, "lark-home");
  const taskDirectory = join(root, "task");
  mkdirSync(privateBin, { recursive: true, mode: 0o700 });
  mkdirSync(homeDirectory, { mode: 0o700 });
  mkdirSync(taskDirectory, { mode: 0o700 });
  writeFileSync(executable, '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o500 });
  chmodSync(executable, 0o500);
  const binarySha256 = createHash("sha256")
    .update(Buffer.from('#!/bin/sh\nprintf "{}\\n"\n', "utf8"))
    .digest("hex");
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const archiveSha256 =
    process.arch === "arm64"
      ? "b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2"
      : "b5dd56d64f9cc1cb7bab80b8eb1dda3c34e76f2a751115a897d0261985b82745";
  const receipt = join(releaseRoot, "install-receipt.json");
  writeFileSync(
    receipt,
    `${JSON.stringify({
      schemaVersion: 1,
      package: "@larksuite/cli",
      version: "1.0.72",
      archiveSha256,
      binarySha256,
      sourceUrl:
        "https://github.com/larksuite/cli/releases/download/v1.0.72/" +
        `lark-cli-1.0.72-darwin-${architecture}.tar.gz`,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(receipt, 0o600);
  return {
    executable,
    runner: createInstalledLarkCliRunnerFactory({
      executable,
      homeDirectory,
    })(taskDirectory),
  };
}

async function runRead(runner: ReturnType<typeof createFixture>["runner"]) {
  return runner.runUser({
    version: 1,
    operation: "minutes.search",
    payload: {
      start: "2026-06-26T00:00:00+08:00",
      end: "2026-07-27T00:00:00+08:00",
    },
  });
}

afterEach(() => {
  codesignFixture.displayOutput = "";
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (
      root?.startsWith(join(realpathSync(tmpdir()), "ea-installed-lark-cli-"))
    ) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("installed lark-cli release verification", () => {
  it(
    "accepts Apple's commented implicit designated requirement",
    async () => {
      const fixture = createFixture();
      codesignFixture.displayOutput = [
        `Executable=${fixture.executable}`,
        '# designated => cdhash H"0123456789abcdef"',
        "",
      ].join("\n");

      await expect(runRead(fixture.runner)).resolves.toEqual({
        state: "SUCCEEDED",
        value: {},
      });
    },
    RELEASE_VERIFICATION_TEST_TIMEOUT_MS,
  );

  it(
    "accepts an embedded designated requirement",
    async () => {
      const fixture = createFixture();
      codesignFixture.displayOutput = [
        `Executable=${fixture.executable}`,
        'designated => identifier "com.example.lark-cli"',
        "",
      ].join("\n");

      await expect(runRead(fixture.runner)).resolves.toEqual({
        state: "SUCCEEDED",
        value: {},
      });
    },
    RELEASE_VERIFICATION_TEST_TIMEOUT_MS,
  );

  it.each([
    ["missing", "Executable=/private/lark-cli\n"],
    ["empty", "# designated => \n"],
    ["embedded", 'notice # designated => cdhash H"bad"\n'],
    [
      "duplicate",
      [
        '# designated => cdhash H"first"',
        '# designated => cdhash H"second"',
        "",
      ].join("\n"),
    ],
    ["nul", '# designated => cdhash H"bad\0value"\n'],
  ])(
    "rejects %s requirement evidence",
    async (_label, displayOutput) => {
      const fixture = createFixture();
      codesignFixture.displayOutput = displayOutput;

      await expect(runRead(fixture.runner)).resolves.toEqual({
        state: "FAILED",
        code: "EXECUTABLE_REJECTED",
      });
    },
    RELEASE_VERIFICATION_TEST_TIMEOUT_MS,
  );
});
