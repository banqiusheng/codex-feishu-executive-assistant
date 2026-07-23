import { lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import * as ts from "typescript";

export type ModuleReferenceSyntax =
  | "import_declaration"
  | "export_declaration"
  | "import_equals"
  | "dynamic_import"
  | "require"
  | "require_resolve"
  | "process_get_builtin_module"
  | "import_type";

export type Capability =
  | "global_fetch"
  | "global_websocket"
  | "global_event_source"
  | "global_xml_http_request"
  | "global_send_beacon"
  | "process_env"
  | "raw_send"
  | "raw_stream"
  | "url_literal"
  | "lark_cli_literal"
  | "dynamic_code"
  | "dynamic_method_call"
  | "dynamic_module_loader"
  | "dynamic_global_access"
  | "process_object";

export interface ImportGraphOptions {
  repositoryRoot: string;
  roots: readonly string[];
}

export interface ModuleReferenceRecord {
  from: string;
  specifier: string;
  syntax: ModuleReferenceSyntax;
  resolvedFile?: string;
}

export interface NonLiteralModuleReference {
  from: string;
  syntax: ModuleReferenceSyntax;
  line: number;
  column: number;
}

export interface UnresolvedRelativeImport {
  from: string;
  specifier: string;
  syntax: ModuleReferenceSyntax;
  reason:
    | "not_found"
    | "outside_repository_root"
    | "not_a_file"
    | "symbolic_link";
}

export interface ParseDiagnosticRecord {
  file: string;
  code: number;
  message: string;
  line: number;
  column: number;
}

export interface CapabilityViolation {
  file: string;
  capability: Capability;
  line: number;
  column: number;
}

export interface ImportGraph {
  reachableFiles: string[];
  moduleReferences: ModuleReferenceRecord[];
  externalImports: ModuleReferenceRecord[];
  unresolvedRelativeImports: UnresolvedRelativeImport[];
  nonLiteralModuleReferences: NonLiteralModuleReference[];
  parseDiagnostics: ParseDiagnosticRecord[];
  capabilityViolations: CapabilityViolation[];
}

interface QueuedFile {
  absolutePath: string;
  realPath: string;
  relativePath: string;
}

type Resolution =
  | Readonly<{ status: "resolved"; file: QueuedFile }>
  | Readonly<{
      status: "unresolved";
      reason: UnresolvedRelativeImport["reason"];
    }>;

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

function toRepositoryPath(
  repositoryRoot: string,
  absolutePath: string,
): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

function pathCandidates(basePath: string): string[] {
  const extension = extname(basePath).toLowerCase();
  if (extension === ".js") {
    const stem = basePath.slice(0, -extension.length);
    return [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`];
  }
  if (extension === ".mjs") {
    const stem = basePath.slice(0, -extension.length);
    return [`${stem}.mts`, `${stem}.mjs`];
  }
  if (extension === ".cjs") {
    const stem = basePath.slice(0, -extension.length);
    return [`${stem}.cts`, `${stem}.cjs`];
  }
  if (extension !== "") return [basePath];
  return [
    basePath,
    ...SOURCE_EXTENSIONS.map(
      (candidateExtension) => `${basePath}${candidateExtension}`,
    ),
    ...SOURCE_EXTENSIONS.map((candidateExtension) =>
      resolve(basePath, `index${candidateExtension}`),
    ),
  ];
}

function resolveFile(
  repositoryRoot: string,
  repositoryRealRoot: string,
  basePath: string,
): Resolution {
  const normalizedBase = resolve(basePath);
  if (!isInside(repositoryRoot, normalizedBase)) {
    return { status: "unresolved", reason: "outside_repository_root" };
  }

  let sawNonFile = false;
  for (const candidate of pathCandidates(normalizedBase)) {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      sawNonFile = true;
      continue;
    }

    let candidateRealPath: string;
    try {
      candidateRealPath = realpathSync(candidate);
    } catch {
      sawNonFile = true;
      continue;
    }
    if (!isInside(repositoryRealRoot, candidateRealPath)) {
      return { status: "unresolved", reason: "outside_repository_root" };
    }
    const expectedRealPath = resolve(
      repositoryRealRoot,
      relative(repositoryRoot, candidate),
    );
    if (stat.isSymbolicLink() || candidateRealPath !== expectedRealPath) {
      return { status: "unresolved", reason: "symbolic_link" };
    }
    try {
      if (!lstatSync(candidateRealPath).isFile()) {
        sawNonFile = true;
        continue;
      }
    } catch {
      sawNonFile = true;
      continue;
    }
    return {
      status: "resolved",
      file: {
        absolutePath: candidate,
        realPath: candidateRealPath,
        relativePath: toRepositoryPath(repositoryRoot, candidate),
      },
    };
  }

  return {
    status: "unresolved",
    reason: sawNonFile ? "not_a_file" : "not_found",
  };
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  if (extension === ".json") return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function parseSourceFile(path: string, sourceText: string): ts.SourceFile {
  return extname(path).toLowerCase() === ".json"
    ? ts.parseJsonText(path, sourceText)
    : ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(path),
      );
}

function sourcePosition(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Readonly<{ line: number; column: number }> {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile, false),
  );
  return { line: position.line + 1, column: position.character + 1 };
}

function stringLiteralValue(value: ts.Node | undefined): string | null {
  return value !== undefined && ts.isStringLiteral(value) ? value.text : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function constantStringValue(value: ts.Node | undefined): string | null {
  if (value === undefined) return null;
  if (ts.isNumericLiteral(value)) return value.text;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  if (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    return constantStringValue(value.expression);
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantStringValue(value.left);
    const right = constantStringValue(value.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text;
    for (const span of value.templateSpans) {
      const expression = constantStringValue(span.expression);
      if (expression === null) return null;
      result += `${expression}${span.literal.text}`;
    }
    return result;
  }
  return null;
}

function literalPropertyKeyValue(value: ts.Expression): string | null {
  const stableValue = unwrapExpression(value);
  if (ts.isNumericLiteral(stableValue)) return stableValue.text;
  if (
    ts.isStringLiteral(stableValue) ||
    ts.isNoSubstitutionTemplateLiteral(stableValue)
  ) {
    return stableValue.text;
  }
  return null;
}

function propertyName(expression: ts.Expression): string | null {
  const stableExpression = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(stableExpression)) {
    return stableExpression.name.text;
  }
  if (
    ts.isElementAccessExpression(stableExpression) &&
    stableExpression.argumentExpression !== undefined
  ) {
    return literalPropertyKeyValue(stableExpression.argumentExpression);
  }
  return null;
}

function propertyOwner(expression: ts.Expression): ts.Expression | null {
  const stableExpression = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(stableExpression) ||
    ts.isElementAccessExpression(stableExpression)
  ) {
    return unwrapExpression(stableExpression.expression);
  }
  return null;
}

function isRequireResolve(expression: ts.Expression): boolean {
  const owner = propertyOwner(expression);
  const stableOwner = owner === null ? null : unwrapExpression(owner);
  return (
    propertyName(expression) === "resolve" &&
    stableOwner !== null &&
    ts.isIdentifier(stableOwner) &&
    stableOwner.text === "require"
  );
}

function isProcessExpression(expression: ts.Expression): boolean {
  const stableExpression = unwrapExpression(expression);
  if (ts.isIdentifier(stableExpression)) {
    return stableExpression.text === "process";
  }
  const owner = propertyOwner(stableExpression);
  if (propertyName(stableExpression) !== "process" || owner === null) {
    return false;
  }
  const stableOwner = unwrapExpression(owner);
  return (
    ts.isIdentifier(stableOwner) &&
    ["global", "globalThis", "self"].includes(stableOwner.text)
  );
}

function isProcessGetBuiltinModule(expression: ts.Expression): boolean {
  const owner = propertyOwner(expression);
  const stableExpression = unwrapExpression(expression);
  const name = ts.isElementAccessExpression(stableExpression)
    ? constantStringValue(stableExpression.argumentExpression)
    : propertyName(stableExpression);
  return (
    name === "getBuiltinModule" && owner !== null && isProcessExpression(owner)
  );
}

function calledName(expression: ts.Expression): string | null {
  const stableExpression = unwrapExpression(expression);
  return ts.isIdentifier(stableExpression)
    ? stableExpression.text
    : propertyName(stableExpression);
}

function isProcessEnv(node: ts.Node): boolean {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const owner = propertyOwner(node);
  return (
    propertyName(node) === "env" && owner !== null && isProcessExpression(owner)
  );
}

function moduleReference(
  specifierNode: ts.Node | undefined,
  syntax: ModuleReferenceSyntax,
  fallbackNode: ts.Node,
): Readonly<
  | { syntax: ModuleReferenceSyntax; specifier: string; node: ts.Node }
  | { syntax: ModuleReferenceSyntax; specifier: null; node: ts.Node }
> {
  return {
    syntax,
    specifier: stringLiteralValue(specifierNode),
    node: specifierNode ?? fallbackNode,
  };
}

function collectModuleReference(
  node: ts.Node,
): ReturnType<typeof moduleReference> | null {
  if (ts.isImportDeclaration(node)) {
    return moduleReference(node.moduleSpecifier, "import_declaration", node);
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
    return moduleReference(node.moduleSpecifier, "export_declaration", node);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return moduleReference(
      node.moduleReference.expression,
      "import_equals",
      node,
    );
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    const literal = ts.isLiteralTypeNode(argument)
      ? argument.literal
      : argument;
    return moduleReference(literal, "import_type", node);
  }
  if (!ts.isCallExpression(node)) return null;
  const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return moduleReference(argument, "dynamic_import", node);
  }
  if (isProcessGetBuiltinModule(node.expression)) {
    return moduleReference(argument, "process_get_builtin_module", node);
  }
  if (isRequireResolve(node.expression)) {
    return moduleReference(argument, "require_resolve", node);
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return moduleReference(argument, "require", node);
  }
  return null;
}

function addCapability(
  target: CapabilityViolation[],
  sourceFile: ts.SourceFile,
  file: string,
  node: ts.Node,
  capability: Capability,
): void {
  target.push({ file, capability, ...sourcePosition(sourceFile, node) });
}

function rawTransportCapability(name: string | null): Capability | null {
  if (name === "send") return "raw_send";
  if (name === "stream") return "raw_stream";
  return null;
}

function isForbiddenGetMember(expression: ts.Expression): boolean {
  return propertyName(expression) === "get";
}

function isDynamicMethodExtraction(node: ts.ElementAccessExpression): boolean {
  return propertyName(node) === null;
}

function isForbiddenGetBinding(node: ts.BindingElement): boolean {
  const bindingName = node.propertyName ?? node.name;
  const name = ts.isComputedPropertyName(bindingName)
    ? literalPropertyKeyValue(bindingName.expression)
    : ts.isIdentifier(bindingName) || ts.isStringLiteral(bindingName)
      ? bindingName.text
      : null;
  return name === "get";
}

function isForbiddenGetAssignment(
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): boolean {
  const assignmentName = node.name;
  const name = ts.isComputedPropertyName(assignmentName)
    ? literalPropertyKeyValue(assignmentName.expression)
    : ts.isIdentifier(assignmentName) || ts.isStringLiteral(assignmentName)
      ? assignmentName.text
      : null;
  if (name !== "get" || !ts.isObjectLiteralExpression(node.parent)) {
    return false;
  }

  let current: ts.Expression = node.parent;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isArrayLiteralExpression(parent) &&
      parent.elements.some((element) => element === current)
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === current &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      current = parent.parent;
      continue;
    }
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === current
    ) {
      return true;
    }
    if (
      !ts.isBinaryExpression(parent) ||
      parent.left !== current ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      return false;
    }
    return true;
  }
  return false;
}

const FORBIDDEN_GLOBAL_CAPABILITIES = new Map<string, Capability>([
  ["fetch", "global_fetch"],
  ["WebSocket", "global_websocket"],
  ["EventSource", "global_event_source"],
  ["XMLHttpRequest", "global_xml_http_request"],
  ["sendBeacon", "global_send_beacon"],
]);

const DYNAMIC_CODE_NAMES = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "constructor",
]);
const GLOBAL_ROOT_NAMES = new Set([
  "global",
  "globalThis",
  "self",
  "navigator",
]);

function isDirectRecognizedProcessUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.questionDotToken === undefined &&
    ["argv", "exitCode", "env", "getBuiltinModule"].includes(parent.name.text)
  );
}

function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.name === node;
}

function collectCapabilities(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  target: CapabilityViolation[],
): void {
  if (isProcessEnv(node)) {
    addCapability(target, sourceFile, file, node, "process_env");
  }

  const constantString = constantStringValue(node);
  if (constantString !== null) {
    if (/(?:https?|wss?):\/\//iu.test(constantString)) {
      addCapability(target, sourceFile, file, node, "url_literal");
    }
    if (constantString.includes("lark-cli")) {
      addCapability(target, sourceFile, file, node, "lark_cli_literal");
    }
    const rawTransport = rawTransportCapability(constantString);
    if (rawTransport !== null) {
      addCapability(target, sourceFile, file, node, rawTransport);
    }
  }

  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const bindingName = node.propertyName ?? node.name;
    const computedBindingName = ts.isComputedPropertyName(bindingName)
      ? literalPropertyKeyValue(bindingName.expression)
      : undefined;
    if (computedBindingName === null) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
    const rawTransport =
      ts.isIdentifier(bindingName) || ts.isStringLiteral(bindingName)
        ? rawTransportCapability(bindingName.text)
        : computedBindingName === undefined
          ? null
          : rawTransportCapability(computedBindingName);
    if (rawTransport !== null) {
      addCapability(target, sourceFile, file, node, rawTransport);
    }
    if (isForbiddenGetBinding(node)) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
  }

  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const assignmentName = node.name;
    const computedAssignmentName = ts.isComputedPropertyName(assignmentName)
      ? literalPropertyKeyValue(assignmentName.expression)
      : undefined;
    if (computedAssignmentName === null) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
    const staticAssignmentName =
      ts.isIdentifier(assignmentName) ||
      ts.isStringLiteral(assignmentName) ||
      ts.isNumericLiteral(assignmentName)
        ? assignmentName.text
        : computedAssignmentName;
    const rawTransport = rawTransportCapability(staticAssignmentName ?? null);
    if (rawTransport !== null) {
      addCapability(target, sourceFile, file, node, rawTransport);
    }
    if (isForbiddenGetAssignment(node)) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
  }

  if (ts.isIdentifier(node)) {
    const globalCapability = FORBIDDEN_GLOBAL_CAPABILITIES.get(node.text);
    if (globalCapability !== undefined) {
      addCapability(target, sourceFile, file, node, globalCapability);
    }
    if (DYNAMIC_CODE_NAMES.has(node.text)) {
      addCapability(target, sourceFile, file, node, "dynamic_code");
    }
    if (node.text === "require") {
      addCapability(target, sourceFile, file, node, "dynamic_module_loader");
    }
    if (GLOBAL_ROOT_NAMES.has(node.text) && !isPropertyNameIdentifier(node)) {
      addCapability(target, sourceFile, file, node, "dynamic_global_access");
    }
    if (
      node.text === "process" &&
      !isPropertyNameIdentifier(node) &&
      !isDirectRecognizedProcessUse(node)
    ) {
      addCapability(target, sourceFile, file, node, "process_object");
    }
  }

  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const name = propertyName(node);
    const globalCapability =
      name === null ? undefined : FORBIDDEN_GLOBAL_CAPABILITIES.get(name);
    if (globalCapability !== undefined) {
      addCapability(target, sourceFile, file, node, globalCapability);
    }
    if (name !== null && DYNAMIC_CODE_NAMES.has(name)) {
      addCapability(target, sourceFile, file, node, "dynamic_code");
    }
    if (
      name === "require" ||
      (name === "getBuiltinModule" && isProcessGetBuiltinModule(node))
    ) {
      addCapability(target, sourceFile, file, node, "dynamic_module_loader");
    }
    const rawTransport = rawTransportCapability(name);
    if (rawTransport !== null) {
      addCapability(target, sourceFile, file, node, rawTransport);
    }
    if (isForbiddenGetMember(node)) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
    if (ts.isElementAccessExpression(node) && isDynamicMethodExtraction(node)) {
      addCapability(target, sourceFile, file, node, "dynamic_method_call");
    }
  }

  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const name = calledName(node.expression);
    const capability =
      name === null ? undefined : FORBIDDEN_GLOBAL_CAPABILITIES.get(name);
    if (capability !== undefined) {
      addCapability(target, sourceFile, file, node, capability);
    }

    if (name !== null && DYNAMIC_CODE_NAMES.has(name)) {
      addCapability(target, sourceFile, file, node, "dynamic_code");
    }
  }
}

export function analyzeImportGraph(options: ImportGraphOptions): ImportGraph {
  const repositoryRoot = resolve(options.repositoryRoot);
  const repositoryRealRoot = realpathSync(repositoryRoot);
  const reachableFiles = new Set<string>();
  const visitedRealPaths = new Set<string>();
  const moduleReferences: ModuleReferenceRecord[] = [];
  const externalImports: ModuleReferenceRecord[] = [];
  const unresolvedRelativeImports: UnresolvedRelativeImport[] = [];
  const nonLiteralModuleReferences: NonLiteralModuleReference[] = [];
  const parseDiagnostics: ParseDiagnosticRecord[] = [];
  const capabilityViolations: CapabilityViolation[] = [];
  const queue: QueuedFile[] = [];

  for (const root of options.roots) {
    const rootResolution = resolveFile(
      repositoryRoot,
      repositoryRealRoot,
      resolve(repositoryRoot, root),
    );
    if (rootResolution.status === "resolved") {
      queue.push(rootResolution.file);
    } else {
      unresolvedRelativeImports.push({
        from: "<root>",
        specifier: root,
        syntax: "import_declaration",
        reason: rootResolution.reason,
      });
    }
  }

  while (queue.length > 0) {
    const queuedFile = queue.shift();
    if (queuedFile === undefined || visitedRealPaths.has(queuedFile.realPath)) {
      continue;
    }
    visitedRealPaths.add(queuedFile.realPath);
    reachableFiles.add(queuedFile.relativePath);

    const sourceText = readFileSync(queuedFile.realPath, "utf8");
    const sourceFile = parseSourceFile(queuedFile.relativePath, sourceText);
    const sourceDiagnostics = (sourceFile as SourceFileWithParseDiagnostics)
      .parseDiagnostics;
    for (const diagnostic of sourceDiagnostics ?? []) {
      const start = diagnostic.start ?? 0;
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      parseDiagnostics.push({
        file: queuedFile.relativePath,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        line: position.line + 1,
        column: position.character + 1,
      });
    }

    if (extname(queuedFile.relativePath).toLowerCase() === ".json") continue;

    const visit = (node: ts.Node): void => {
      collectCapabilities(
        node,
        sourceFile,
        queuedFile.relativePath,
        capabilityViolations,
      );

      const reference = collectModuleReference(node);
      if (reference !== null) {
        if (reference.specifier === null) {
          nonLiteralModuleReferences.push({
            from: queuedFile.relativePath,
            syntax: reference.syntax,
            ...sourcePosition(sourceFile, reference.node),
          });
        } else if (
          reference.specifier.startsWith(".") ||
          isAbsolute(reference.specifier)
        ) {
          const resolution = resolveFile(
            repositoryRoot,
            repositoryRealRoot,
            resolve(dirname(queuedFile.absolutePath), reference.specifier),
          );
          if (resolution.status === "resolved") {
            const record: ModuleReferenceRecord = {
              from: queuedFile.relativePath,
              specifier: reference.specifier,
              syntax: reference.syntax,
              resolvedFile: resolution.file.relativePath,
            };
            moduleReferences.push(record);
            queue.push(resolution.file);
          } else {
            moduleReferences.push({
              from: queuedFile.relativePath,
              specifier: reference.specifier,
              syntax: reference.syntax,
            });
            unresolvedRelativeImports.push({
              from: queuedFile.relativePath,
              specifier: reference.specifier,
              syntax: reference.syntax,
              reason: resolution.reason,
            });
          }
        } else {
          const record: ModuleReferenceRecord = {
            from: queuedFile.relativePath,
            specifier: reference.specifier,
            syntax: reference.syntax,
          };
          moduleReferences.push(record);
          externalImports.push(record);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    reachableFiles: [...reachableFiles].sort(),
    moduleReferences,
    externalImports,
    unresolvedRelativeImports,
    nonLiteralModuleReferences,
    parseDiagnostics,
    capabilityViolations,
  };
}
