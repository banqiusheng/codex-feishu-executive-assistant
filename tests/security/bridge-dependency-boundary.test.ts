import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as ts from "typescript";

import {
  ASSISTANT_RUNTIME_PORTS_REQUIRED,
  startChannel,
} from "../../packages/bridge/src/bot/channel.js";
import { analyzeImportGraph } from "./import-graph.js";

const repositoryRoot = resolve(".");
const temporaryRoots: string[] = [];

const boundaryCases = [
  {
    name: "CLI",
    root: "packages/bridge/src/cli/index.ts",
    reachable: [
      "packages/bridge/package.json",
      "packages/bridge/src/cli/commands/start.ts",
      "packages/bridge/src/cli/index.ts",
    ],
    externals: ["commander"],
  },
  {
    name: "package root",
    root: "packages/bridge/src/index.ts",
    reachable: [
      "packages/bridge/src/bot/channel.ts",
      "packages/bridge/src/index.ts",
      "packages/bridge/src/runtime/assistant-channel.ts",
      "packages/bridge/src/runtime/progress-reporter.ts",
      "packages/bridge/src/runtime/system-reply.ts",
      "packages/bridge/src/security/ingress-guard.ts",
      "packages/bridge/src/security/policy.ts",
    ],
    externals: ["@executive-assistant/contracts", "node:crypto"],
  },
  {
    name: "channel",
    root: "packages/bridge/src/bot/channel.ts",
    reachable: [
      "packages/bridge/src/bot/channel.ts",
      "packages/bridge/src/runtime/assistant-channel.ts",
      "packages/bridge/src/runtime/system-reply.ts",
      "packages/bridge/src/security/ingress-guard.ts",
      "packages/bridge/src/security/policy.ts",
    ],
    externals: ["@executive-assistant/contracts", "node:crypto"],
  },
  {
    name: "runner",
    root: "packages/bridge/src/agent/codex-runner.ts",
    reachable: [
      "packages/bridge/src/agent/codex-runner.ts",
      "packages/bridge/src/security/workspace.ts",
    ],
    externals: [
      "node:events",
      "node:fs/promises",
      "node:path",
      "node:stream",
      "node:util",
    ],
  },
] as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("supported bridge dependency boundary", () => {
  for (const boundary of boundaryCases) {
    it(`locks the exact ${boundary.name} reachable and external dependency set`, () => {
      const graph = analyzeImportGraph({
        repositoryRoot,
        roots: [boundary.root],
      });

      expect(graph.reachableFiles).toEqual([...boundary.reachable].sort());
      expect(
        [
          ...new Set(graph.externalImports.map(({ specifier }) => specifier)),
        ].sort(),
      ).toEqual([...boundary.externals].sort());
      expect(graph.unresolvedRelativeImports).toEqual([]);
      expect(graph.parseDiagnostics).toEqual([]);
      expect(graph.nonLiteralModuleReferences).toEqual([]);
      expect(graph.capabilityViolations).toEqual([]);
    });
  }

  it("keeps every supported entry graph free of runtime-computed element access", () => {
    const reachableFiles = new Set(
      boundaryCases.flatMap(
        ({ root }) =>
          analyzeImportGraph({ repositoryRoot, roots: [root] }).reachableFiles,
      ),
    );
    const runtimeComputedAccesses: string[] = [];

    for (const file of [...reachableFiles].sort()) {
      if (!file.endsWith(".ts")) continue;
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(resolve(repositoryRoot, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isElementAccessExpression(node)) {
          const key = node.argumentExpression;
          if (
            key === undefined ||
            (!ts.isStringLiteral(key) &&
              !ts.isNumericLiteral(key) &&
              !ts.isNoSubstitutionTemplateLiteral(key))
          ) {
            const position = sourceFile.getLineAndCharacterOfPosition(
              node.getStart(sourceFile, false),
            );
            runtimeComputedAccesses.push(
              `${file}:${position.line + 1}:${position.character + 1}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(runtimeComputedAccesses).toEqual([]);
  });

  it("parses every supported module-reference syntax and resolves NodeNext source paths", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    mkdirSync(join(fixtureRoot, "reexported"));
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        'import "./imported.js";',
        'export * from "./reexported";',
        'import legacy = require("./legacy");',
        'void import("./dynamic");',
        'const required = require("./required");',
        'const resolved = require.resolve("./resolved");',
        'type Imported = import("./types").Imported;',
        'import data from "./data.json";',
        "void legacy; void required; void resolved; void data;",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureRoot, "imported.ts"),
      "export const imported = true;\n",
    );
    writeFileSync(
      join(fixtureRoot, "reexported", "index.ts"),
      "export const reexported = true;\n",
    );
    for (const file of [
      "legacy.ts",
      "dynamic.ts",
      "required.ts",
      "resolved.ts",
      "types.ts",
    ]) {
      writeFileSync(join(fixtureRoot, file), "export type Imported = true;\n");
    }
    writeFileSync(join(fixtureRoot, "data.json"), '{"safe":true}\n');

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.reachableFiles).toEqual([
      "data.json",
      "dynamic.ts",
      "imported.ts",
      "legacy.ts",
      "reexported/index.ts",
      "required.ts",
      "resolved.ts",
      "root.ts",
      "types.ts",
    ]);
    expect(graph.moduleReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "./imported.js",
          syntax: "import_declaration",
        }),
        expect.objectContaining({
          specifier: "./reexported",
          syntax: "export_declaration",
        }),
        expect.objectContaining({
          specifier: "./legacy",
          syntax: "import_equals",
        }),
        expect.objectContaining({
          specifier: "./dynamic",
          syntax: "dynamic_import",
        }),
        expect.objectContaining({ specifier: "./required", syntax: "require" }),
        expect.objectContaining({
          specifier: "./resolved",
          syntax: "require_resolve",
        }),
        expect.objectContaining({
          specifier: "./types",
          syntax: "import_type",
        }),
      ]),
    );
    expect(graph.externalImports).toEqual([]);
    expect(graph.unresolvedRelativeImports).toEqual([]);
    expect(graph.parseDiagnostics).toEqual([]);
    expect(graph.nonLiteralModuleReferences).toEqual([]);
  });

  it("fails closed on non-literal dynamic import, require, and require.resolve", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        'const path = "./child.js";',
        "void import(path);",
        "require(path);",
        "require.resolve(path);",
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(
      graph.nonLiteralModuleReferences.map(({ syntax }) => syntax),
    ).toEqual(["dynamic_import", "require", "require_resolve"]);
  });

  it("fails closed on missing or extra module-loader arguments", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        "void import();",
        "require();",
        "require.resolve();",
        'void import("./child", {});',
        'require("./child", {});',
        'require.resolve("./child", {});',
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(
      graph.nonLiteralModuleReferences.map(({ syntax }) => syntax),
    ).toEqual([
      "dynamic_import",
      "require",
      "require_resolve",
      "dynamic_import",
      "require",
      "require_resolve",
    ]);
  });

  it("fails closed on parse diagnostics and unresolved relative imports", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      'import "./missing.js";\nexport const broken = ;\n',
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.parseDiagnostics).not.toEqual([]);
    expect(graph.unresolvedRelativeImports).toEqual([
      expect.objectContaining({
        from: "root.ts",
        reason: "not_found",
        specifier: "./missing.js",
      }),
    ]);
  });

  it("fails closed when a relative import reaches a symlink outside the repository", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    const outsideRoot = mkdtempSync(
      join(tmpdir(), "assistant-import-outside-"),
    );
    temporaryRoots.push(fixtureRoot, outsideRoot);
    writeFileSync(join(fixtureRoot, "root.ts"), 'import "./escape.js";\n');
    writeFileSync(
      join(outsideRoot, "outside.ts"),
      "export const secret = 1;\n",
    );
    symlinkSync(
      join(outsideRoot, "outside.ts"),
      join(fixtureRoot, "escape.ts"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.unresolvedRelativeImports).toEqual([
      expect.objectContaining({
        from: "root.ts",
        reason: "outside_repository_root",
        specifier: "./escape.js",
      }),
    ]);
    expect(graph.reachableFiles).toEqual(["root.ts"]);
  });

  it("fails closed on a source symlink even when its target stays inside the repository", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    mkdirSync(join(fixtureRoot, "nested"));
    writeFileSync(join(fixtureRoot, "root.ts"), 'import "./alias.js";\n');
    writeFileSync(
      join(fixtureRoot, "nested", "actual.ts"),
      'import "./hidden.js";\n',
    );
    writeFileSync(
      join(fixtureRoot, "nested", "hidden.ts"),
      'fetch("https://invalid.example");\n',
    );
    symlinkSync(
      join(fixtureRoot, "nested", "actual.ts"),
      join(fixtureRoot, "alias.ts"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.unresolvedRelativeImports).toEqual([
      expect.objectContaining({
        from: "root.ts",
        reason: "symbolic_link",
        specifier: "./alias.js",
      }),
    ]);
    expect(graph.reachableFiles).toEqual(["root.ts"]);
  });

  it("fails closed when an in-repository source directory is reached through a symlink", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    mkdirSync(join(fixtureRoot, "nested"));
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      'import "./alias/actual.js";\n',
    );
    writeFileSync(
      join(fixtureRoot, "nested", "actual.ts"),
      'import "./hidden.js";\n',
    );
    writeFileSync(
      join(fixtureRoot, "nested", "hidden.ts"),
      'fetch("https://invalid.example");\n',
    );
    symlinkSync(join(fixtureRoot, "nested"), join(fixtureRoot, "alias"), "dir");

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.unresolvedRelativeImports).toEqual([
      expect.objectContaining({
        from: "root.ts",
        reason: "symbolic_link",
        specifier: "./alias/actual.js",
      }),
    ]);
    expect(graph.reachableFiles).toEqual(["root.ts"]);
  });

  it("treats process.getBuiltinModule as a module loader and rejects dynamic specifiers", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        'const https = process.getBuiltinModule("node:https");',
        'const prefix = "node:";',
        'const net = process["get" + "BuiltinModule"](prefix + "net");',
        "void https; void net;",
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.externalImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "node:https",
          syntax: "process_get_builtin_module",
        }),
      ]),
    );
    expect(graph.nonLiteralModuleReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ syntax: "process_get_builtin_module" }),
      ]),
    );
    expect(
      graph.capabilityViolations.map(({ capability }) => capability),
    ).toContain("dynamic_module_loader");
  });

  it("fails closed on aliased globals, wrapped process access, composed URLs, dynamic code, and every generic raw transport", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        "const indirectFetch = fetch;",
        "const IndirectWebSocket = WebSocket;",
        "const IndirectEventSource = EventSource;",
        "const IndirectXhr = XMLHttpRequest;",
        "const indirectBeacon = navigator.sendBeacon;",
        'void indirectFetch("https" + "://invalid.example/fetch");',
        'void new IndirectWebSocket(`wss${"://"}invalid.example/socket`);',
        'void new IndirectEventSource("https" + "://invalid.example/events");',
        "void new IndirectXhr();",
        'void indirectBeacon("/collect", "secret");',
        "void (process).env.SECRET;",
        'gatewayEvilSocket.send("secret");',
        "gatewayClient.stream();",
        'const evaluate = eval; evaluate("void 0");',
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });
    const capabilities = new Set(
      graph.capabilityViolations.map(({ capability }) => capability),
    );

    expect(capabilities).toEqual(
      new Set([
        "global_fetch",
        "global_websocket",
        "global_event_source",
        "global_xml_http_request",
        "global_send_beacon",
        "dynamic_global_access",
        "process_env",
        "process_object",
        "raw_send",
        "raw_stream",
        "url_literal",
        "dynamic_code",
      ]),
    );
  });

  it("fails closed when raw transport methods are extracted or dynamically selected", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        "const { send: emit, stream: pump } = rawClient;",
        'emit("secret");',
        "pump();",
        "const assignedSend = rawClient.send;",
        'const assignedStream = rawClient[`str${"eam"}`];',
        'assignedSend("secret");',
        "assignedStream();",
        "const selectedMethod = runtimeSelectedMethod;",
        'rawClient[selectedMethod]("secret");',
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });
    const capabilities = new Set(
      graph.capabilityViolations.map(({ capability }) => capability),
    );

    expect(capabilities).toEqual(
      new Set(["raw_send", "raw_stream", "dynamic_method_call"]),
    );
  });

  it.each([
    [
      "a variable alias",
      [
        "declare const runtimeSelectedMethod: string;",
        "const invoke = rawClient[runtimeSelectedMethod];",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a computed object binding",
      [
        "declare const runtimeSelectedMethod: string;",
        "const { [runtimeSelectedMethod]: invoke } = rawClient;",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a comma-expression callee",
      [
        "declare const runtimeSelectedMethod: string;",
        '(0, rawClient[runtimeSelectedMethod])("secret");',
      ].join("\n"),
    ],
    [
      "Reflect.apply",
      [
        "declare const runtimeSelectedMethod: string;",
        'Reflect.apply(rawClient[runtimeSelectedMethod], rawClient, ["secret"]);',
      ].join("\n"),
    ],
    [
      "Function.prototype.call",
      [
        "declare const runtimeSelectedMethod: string;",
        'rawClient[runtimeSelectedMethod].call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "a comma-expression initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "const invoke = (0, rawClient[runtimeSelectedMethod]);",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a conditional initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const chooseRuntimeMethod: boolean;",
        "declare const fallback: (...args: unknown[]) => unknown;",
        "const invoke = chooseRuntimeMethod ? rawClient[runtimeSelectedMethod] : fallback;",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "an object-property initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "const holder = { invoke: rawClient[runtimeSelectedMethod] };",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "Reflect.get",
      [
        "declare const runtimeSelectedMethod: string;",
        "const invoke = Reflect.get(rawClient, runtimeSelectedMethod);",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "Reflect.get with Function.prototype.call",
      [
        "declare const runtimeSelectedMethod: string;",
        'Reflect.get(rawClient, runtimeSelectedMethod).call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "Reflect.get through Function.prototype.call",
      [
        "declare const runtimeSelectedMethod: string;",
        "Reflect.get.call(",
        "  Reflect,",
        "  rawClient,",
        "  runtimeSelectedMethod,",
        ').call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "Reflect.get through Function.prototype.apply",
      [
        "declare const runtimeSelectedMethod: string;",
        "Reflect.get.apply(",
        "  Reflect,",
        "  [rawClient, runtimeSelectedMethod],",
        ').call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "a direct Reflect.get alias",
      [
        "declare const runtimeSelectedMethod: string;",
        "const read = Reflect.get;",
        "const invoke = read(rawClient, runtimeSelectedMethod);",
        'invoke.call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "a destructured Reflect.get alias",
      [
        "declare const runtimeSelectedMethod: string;",
        "const { get: read } = Reflect;",
        "const invoke = read(rawClient, runtimeSelectedMethod);",
        'invoke.call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "a destructuring-assignment Reflect.get alias",
      [
        "declare const runtimeSelectedMethod: string;",
        "let read: typeof Reflect.get;",
        "({ get: read } = Reflect);",
        "const invoke = read(rawClient, runtimeSelectedMethod);",
        'invoke.call(rawClient, "secret");',
      ].join("\n"),
    ],
    [
      "a computed assignment pattern",
      [
        "declare const runtimeSelectedMethod: string;",
        "let invoke: (...args: unknown[]) => unknown;",
        "({ [runtimeSelectedMethod]: invoke } = rawClient);",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a static property assignment",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const holder: { invoke: (...args: unknown[]) => unknown };",
        "holder.invoke = rawClient[runtimeSelectedMethod];",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "a dynamic property assignment target",
      [
        "declare const runtimeSelectedMethod: string;",
        'const destinationKey = "invoke";',
        "declare const holder: { invoke: (...args: unknown[]) => unknown };",
        "holder[destinationKey] = rawClient[runtimeSelectedMethod];",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "a wrapped const property assignment target",
      [
        "declare const runtimeSelectedMethod: string;",
        'const destinationKey = "invoke";',
        "declare const holder: { invoke: (...args: unknown[]) => unknown };",
        'holder[destinationKey as "invoke"] =',
        "  rawClient[runtimeSelectedMethod];",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "same-named const keys in separate lexical blocks",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const first: { invoke: (...args: unknown[]) => unknown };",
        "declare const second: { invoke: (...args: unknown[]) => unknown };",
        "{",
        '  const destinationKey = "invoke";',
        "  first[destinationKey] = rawClient[runtimeSelectedMethod];",
        '  first.invoke("secret");',
        "}",
        "{",
        '  const destinationKey = "invoke";',
        "  second[destinationKey] = rawClient[runtimeSelectedMethod];",
        '  second.invoke("secret");',
        "}",
      ].join("\n"),
    ],
    [
      "a nullish assignment",
      [
        "declare const runtimeSelectedMethod: string;",
        "let invoke: ((...args: unknown[]) => unknown) | undefined;",
        "invoke ??= rawClient[runtimeSelectedMethod];",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a tagged-template callee",
      [
        "declare const runtimeSelectedMethod: string;",
        "rawClient[runtimeSelectedMethod]`secret`;",
      ].join("\n"),
    ],
    [
      "an array destructuring assignment",
      [
        "declare const runtimeSelectedMethod: string;",
        "let invoke: (...args: unknown[]) => unknown;",
        "[invoke] = [rawClient[runtimeSelectedMethod]];",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "an object destructuring assignment",
      [
        "declare const runtimeSelectedMethod: string;",
        "let invoke: (...args: unknown[]) => unknown;",
        "({ invoke } = { invoke: rawClient[runtimeSelectedMethod] });",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "a class property initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "class Holder {",
        "  static invoke = rawClient[runtimeSelectedMethod];",
        "}",
        'Holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "a class heritage initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "class DynamicBase extends rawClient[runtimeSelectedMethod] {}",
        'new DynamicBase("secret");',
      ].join("\n"),
    ],
    [
      "a parameter default initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "function invokeSelected(",
        "  invoke = rawClient[runtimeSelectedMethod],",
        ") {",
        '  invoke("secret");',
        "}",
        "invokeSelected();",
      ].join("\n"),
    ],
    [
      "a destructuring default initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "const { invoke = rawClient[runtimeSelectedMethod] } = {};",
        'invoke("secret");',
      ].join("\n"),
    ],
    [
      "an object descriptor initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const holder: { invoke: (...args: unknown[]) => unknown };",
        'Object.defineProperty(holder, "invoke", {',
        "  value: rawClient[runtimeSelectedMethod],",
        "});",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "a computed object descriptor initializer",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const holder: { invoke: (...args: unknown[]) => unknown };",
        'Object.defineProperty(holder, "invoke", {',
        '  ["value"]: rawClient[runtimeSelectedMethod],',
        "});",
        'holder.invoke("secret");',
      ].join("\n"),
    ],
    [
      "a for-of binding",
      [
        "declare const runtimeSelectedMethod: string;",
        "for (const invoke of [rawClient[runtimeSelectedMethod]]) {",
        '  invoke("secret");',
        "}",
      ].join("\n"),
    ],
    [
      "Function.prototype.call.call dispatch",
      [
        "declare const runtimeSelectedMethod: string;",
        "(() => undefined).call.call(",
        "  rawClient[runtimeSelectedMethod],",
        "  rawClient,",
        '  "secret",',
        ");",
      ].join("\n"),
    ],
    [
      "Function.prototype.apply.call dispatch",
      [
        "declare const runtimeSelectedMethod: string;",
        "(() => undefined).apply.call(",
        "  rawClient[runtimeSelectedMethod],",
        "  rawClient,",
        '  ["secret"],',
        ");",
      ].join("\n"),
    ],
    [
      "a decorator callee",
      [
        "declare const runtimeSelectedMethod: string;",
        "@(rawClient[runtimeSelectedMethod])",
        "class Decorated {}",
        "void Decorated;",
      ].join("\n"),
    ],
    [
      "a throw-catch binding",
      [
        "declare const runtimeSelectedMethod: string;",
        "try {",
        "  throw rawClient[runtimeSelectedMethod];",
        "} catch (invoke) {",
        '  invoke("secret");',
        "}",
      ].join("\n"),
    ],
    [
      "a dynamic call hidden by strict equality",
      [
        "declare const runtimeSelectedMethod: string;",
        'void (rawClient[runtimeSelectedMethod]("secret") === true);',
      ].join("\n"),
    ],
    [
      "a dynamic call hidden by arithmetic",
      [
        "declare const runtimeSelectedMethod: string;",
        'void (rawClient[runtimeSelectedMethod]("secret") + 1);',
      ].join("\n"),
    ],
    [
      "a dynamic call hidden by Number.isSafeInteger",
      [
        "declare const runtimeSelectedMethod: string;",
        'void Number.isSafeInteger(rawClient[runtimeSelectedMethod]("secret"));',
      ].join("\n"),
    ],
    [
      "a dynamic constructor hidden by arithmetic",
      [
        "declare const runtimeSelectedMethod: string;",
        "void (new rawClient[runtimeSelectedMethod]() + 1);",
      ].join("\n"),
    ],
    [
      "a dynamic value coerced by arithmetic",
      [
        "declare const runtimeSelectedMethod: string;",
        "void (rawClient[runtimeSelectedMethod] + 1);",
      ].join("\n"),
    ],
    [
      "a dynamic instanceof target",
      [
        "declare const runtimeSelectedMethod: string;",
        "void ({} instanceof rawClient[runtimeSelectedMethod]);",
      ].join("\n"),
    ],
    [
      "a dynamic value hidden by loose equality",
      [
        "declare const runtimeSelectedMethod: string;",
        "void (rawClient[runtimeSelectedMethod] == 0);",
      ].join("\n"),
    ],
    [
      "a dynamic value used by the in operator",
      [
        "declare const runtimeSelectedMethod: string;",
        'void ("send" in rawClient[runtimeSelectedMethod]);',
      ].join("\n"),
    ],
    [
      "an optional dynamic call",
      [
        "declare const runtimeSelectedMethod: string;",
        'void rawClient[runtimeSelectedMethod]?.("secret");',
      ].join("\n"),
    ],
    [
      "a locally shadowed Number consumer",
      [
        "declare const runtimeSelectedMethod: string;",
        "const Number = (invoke: () => unknown) => invoke();",
        "void Number(rawClient[runtimeSelectedMethod]);",
      ].join("\n"),
    ],
    [
      "a locally shadowed Number.isSafeInteger consumer",
      [
        "declare const runtimeSelectedMethod: string;",
        "const Number = { isSafeInteger: (invoke: () => unknown) => invoke() };",
        "void Number.isSafeInteger(rawClient[runtimeSelectedMethod]);",
      ].join("\n"),
    ],
    [
      "a const property key shadowed by a parameter",
      [
        'const method = "harmless";',
        "function invokeSelected(method: string) {",
        '  rawClient[method]("secret");',
        "}",
        "invokeSelected(runtimeSelectedMethod);",
      ].join("\n"),
    ],
    [
      "a const property key shadowed by let",
      [
        'const method = "harmless";',
        "{",
        "  let method = runtimeSelectedMethod;",
        '  rawClient[method]("secret");',
        "}",
      ].join("\n"),
    ],
    [
      "a const property key shadowed by a catch binding",
      [
        'const method = "harmless";',
        "try {",
        "  throw runtimeSelectedMethod;",
        "} catch (method) {",
        '  rawClient[method]("secret");',
        "}",
      ].join("\n"),
    ],
    [
      "a consumed dynamic assignment target",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const holder: Record<string, unknown>;",
        "void ((holder[runtimeSelectedMethod] = () => undefined) as () => void)();",
      ].join("\n"),
    ],
    [
      "a standalone dynamic assignment target",
      [
        "declare const runtimeSelectedMethod: string;",
        "declare const holder: Record<string, unknown>;",
        "holder[runtimeSelectedMethod] = undefined;",
      ].join("\n"),
    ],
    [
      "a Reflect.get alias in a for-of binding",
      [
        "for (const { get: read } of [Reflect]) {",
        "  void read(rawClient, runtimeSelectedMethod);",
        "}",
      ].join("\n"),
    ],
    [
      "a Reflect.get alias in a nested array binding",
      [
        "const [{ get: read }] = [Reflect];",
        "void read(rawClient, runtimeSelectedMethod);",
      ].join("\n"),
    ],
    [
      "a Reflect.get alias in a catch binding",
      [
        "try {",
        "  throw Reflect;",
        "} catch ({ get: read }) {",
        "  void read(rawClient, runtimeSelectedMethod);",
        "}",
      ].join("\n"),
    ],
    [
      "a Reflect object alias with a get member",
      [
        "const reflection = Reflect;",
        "void reflection.get(rawClient, runtimeSelectedMethod);",
      ].join("\n"),
    ],
    [
      "a comma-wrapped Reflect get member",
      "void (0, Reflect).get(rawClient, runtimeSelectedMethod);",
    ],
    [
      "a get alias in a nested array assignment",
      [
        "let read: typeof Reflect.get;",
        "[{ get: read }] = [Reflect];",
        "void read(rawClient, runtimeSelectedMethod);",
      ].join("\n"),
    ],
    [
      "a get alias in a for-of assignment",
      [
        "let read: typeof Reflect.get;",
        "for ({ get: read } of [Reflect]) {",
        "  void read(rawClient, runtimeSelectedMethod);",
        "}",
      ].join("\n"),
    ],
    [
      "a get alias in a nested object assignment",
      [
        "let read: typeof Reflect.get;",
        "({ outer: { get: read } } = { outer: Reflect });",
        "void read(rawClient, runtimeSelectedMethod);",
      ].join("\n"),
    ],
    [
      "a computed numeric expression property key",
      'void rawClient[1 + 2]("secret");',
    ],
  ])(
    "fails closed when a dynamic transport is extracted through %s",
    (_name, source) => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "assistant-import-graph-"),
      );
      temporaryRoots.push(fixtureRoot);
      writeFileSync(join(fixtureRoot, "root.ts"), `${source}\n`);

      const graph = analyzeImportGraph({
        repositoryRoot: fixtureRoot,
        roots: ["root.ts"],
      });

      expect(
        graph.capabilityViolations.map(({ capability }) => capability),
      ).toContain("dynamic_method_call");
    },
  );

  it.each([
    [
      "packages/bridge/src/runtime/assistant-channel.ts",
      [
        "function snapshotRawMetadata() {",
        "  const snapshot: Record<string, unknown> = {};",
        "  const record: Record<string, unknown> = rawClient;",
        "  const key = runtimeSelectedMethod;",
        "  void ((snapshot[key] = record[key]) as () => void)();",
        "}",
        "snapshotRawMetadata();",
      ].join("\n"),
    ],
    [
      "packages/bridge/src/runtime/system-reply.ts",
      [
        "function cancellationText(kind: string) {",
        "  const CANCELLATION_TEXT = rawClient;",
        '  return CANCELLATION_TEXT[kind]("secret");',
        "}",
        "void cancellationText(runtimeSelectedMethod);",
      ].join("\n"),
    ],
  ])(
    "fails closed when an audited source-path shape is consumed in %s",
    (file, source) => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "assistant-import-graph-"),
      );
      temporaryRoots.push(fixtureRoot);
      const target = join(fixtureRoot, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, `${source}\n`);

      const graph = analyzeImportGraph({
        repositoryRoot: fixtureRoot,
        roots: [file],
      });

      expect(
        graph.capabilityViolations.map(({ capability }) => capability),
      ).toContain("dynamic_method_call");
    },
  );

  it("fails closed when process or a global root is aliased and when constructor enables dynamic code", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        "const processAlias = process;",
        'void processAlias.getBuiltinModule("node:https");',
        "const globalAlias = globalThis;",
        'const capabilityName = "fetch";',
        'void globalAlias[capabilityName]("https://invalid.example");',
        'void (() => undefined).constructor("return 1")();',
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });
    const capabilities = new Set(
      graph.capabilityViolations.map(({ capability }) => capability),
    );

    expect(capabilities).toEqual(
      new Set([
        "process_object",
        "dynamic_global_access",
        "dynamic_code",
        "dynamic_method_call",
        "url_literal",
      ]),
    );
  });

  it("allows only exact direct process.argv and process.exitCode access", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        "void process.argv;",
        "process.exitCode = 1;",
        "void process?.argv;",
        'void process["argv"];',
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(
      graph.capabilityViolations.filter(
        ({ capability }) => capability === "process_object",
      ),
    ).toHaveLength(2);
  });

  it("detects direct network, environment, raw transport, URL, and lark-cli capabilities", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, "root.ts"),
      [
        'fetch("https://invalid.example/one");',
        'new WebSocket("wss://invalid.example");',
        'new EventSource("https://invalid.example/events");',
        "new XMLHttpRequest();",
        'navigator.sendBeacon("/collect", "secret");',
        "void process.env.SECRET;",
        'rawSocket.send("secret");',
        "rawClient.stream();",
        'gateway.send("also forbidden");',
        "gatewayClient.stream();",
        'const endpoint = "https://invalid.example/two";',
        'const executable = "lark-cli";',
        "void endpoint; void executable;",
      ].join("\n"),
    );

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });
    const capabilities = new Set(
      graph.capabilityViolations.map(({ capability }) => capability),
    );

    expect(capabilities).toEqual(
      new Set([
        "global_fetch",
        "global_websocket",
        "global_event_source",
        "global_xml_http_request",
        "global_send_beacon",
        "dynamic_global_access",
        "process_env",
        "raw_send",
        "raw_stream",
        "url_literal",
        "lark_cli_literal",
      ]),
    );
    expect(
      graph.capabilityViolations.filter(
        ({ capability }) =>
          capability === "raw_send" || capability === "raw_stream",
      ),
    ).toHaveLength(4);
  });

  it("sees forbidden externals reached by dynamic import", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "assistant-import-graph-"));
    temporaryRoots.push(fixtureRoot);
    writeFileSync(join(fixtureRoot, "root.ts"), 'void import("node:https");\n');

    const graph = analyzeImportGraph({
      repositoryRoot: fixtureRoot,
      roots: ["root.ts"],
    });

    expect(graph.externalImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specifier: "node:https" }),
      ]),
    );
  });

  it("fails before source creation when durable runtime ports are absent", async () => {
    const sourceFactory = vi.fn(() => {
      throw new Error("legacy source must not be created");
    });
    const cardEvidenceVerifier = { verify: vi.fn() };
    const lifecycleSink = { record: vi.fn() };

    await expect(
      startChannel({
        appId: "cli_a",
        tenantKey: "tenant_a",
        runtime: {},
        sourceFactory,
        cardEvidenceVerifier,
        lifecycleSink,
      } as never),
    ).rejects.toThrow(ASSISTANT_RUNTIME_PORTS_REQUIRED);

    expect(sourceFactory).not.toHaveBeenCalled();
    expect(cardEvidenceVerifier.verify).not.toHaveBeenCalled();
    expect(lifecycleSink.record).not.toHaveBeenCalled();
  });
});
