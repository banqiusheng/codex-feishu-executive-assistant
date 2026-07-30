import { Buffer } from "node:buffer";

const MAX_STDOUT_BYTES = 32 * 1024;
const MAX_PROTOCOL_LINES = 2;
const AUTHORIZATION_ORIGIN = "https://accounts.feishu.cn";
const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

export type RuntimeUserAuthorizationInspection =
  | Readonly<{ state: "READY" }>
  | Readonly<{ state: "APP_SCOPE_MISSING" }>
  | Readonly<{
      state: "USER_AUTH_REQUIRED";
      missingScopes: readonly string[];
    }>;

export type RuntimeUserAuthorizationRoute = Readonly<{
  chatId: string;
  replyToMessageId: string;
}>;

export type RuntimeUserAuthorizationDecision =
  | Readonly<{ state: "READY" }>
  | Readonly<{ state: "AUTHORIZATION_REQUIRED" }>
  | Readonly<{ state: "BLOCKED_APP_SCOPE" }>
  | Readonly<{ state: "CLOSED" }>;

export type RuntimeUserAuthHelperHandle = Readonly<{
  stdout: AsyncIterable<Uint8Array>;
  result: Promise<
    Readonly<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>
  >;
  stop(): Promise<void>;
}>;

export type RuntimeUserAuthorizationFlowDependencies = Readonly<{
  inspect(): Promise<RuntimeUserAuthorizationInspection>;
  startHelper(
    missingScopes: readonly string[],
  ): Promise<RuntimeUserAuthHelperHandle>;
  sendAuthorizationCard(
    input: RuntimeUserAuthorizationRoute &
      Readonly<{ authorizationUrl: string }>,
  ): Promise<void>;
  sendText(
    input: RuntimeUserAuthorizationRoute & Readonly<{ text: string }>,
  ): Promise<void>;
}>;

export type RuntimeUserAuthorizationFlow = Readonly<{
  ensureAuthorized(
    route: RuntimeUserAuthorizationRoute,
  ): Promise<RuntimeUserAuthorizationDecision>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}>;

type ActiveFlow = Readonly<{
  decision: Promise<RuntimeUserAuthorizationDecision>;
  completion: Promise<void>;
}>;

type AuthorizationUrlEvent = Readonly<{
  event: "authorization_url";
  url: string;
}>;

type AuthorizationResultEvent = Readonly<{
  event: "authorization_result";
  status: "complete" | "blocked";
}>;

function exactRoute(value: RuntimeUserAuthorizationRoute) {
  if (
    value === null ||
    typeof value !== "object" ||
    !exactIdentifier(value.chatId) ||
    !exactIdentifier(value.replyToMessageId)
  ) {
    throw new Error("USER_AUTH_ROUTE_INVALID");
  }
  return Object.freeze({
    chatId: value.chatId,
    replyToMessageId: value.replyToMessageId,
  });
}

function exactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function parseAuthorizationUrl(value: unknown): AuthorizationUrlEvent {
  const snapshot = exactObject(value, ["event", "url"]);
  if (
    snapshot === null ||
    snapshot.event !== "authorization_url" ||
    typeof snapshot.url !== "string" ||
    Buffer.byteLength(snapshot.url, "utf8") > 8_192
  ) {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(snapshot.url);
  } catch {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  if (
    parsed.origin !== AUTHORIZATION_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  return Object.freeze({
    event: "authorization_url",
    url: parsed.href,
  });
}

function parseAuthorizationResult(value: unknown): AuthorizationResultEvent {
  const snapshot = exactObject(value, ["event", "status"]);
  if (
    snapshot === null ||
    snapshot.event !== "authorization_result" ||
    (snapshot.status !== "complete" && snapshot.status !== "blocked")
  ) {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  return Object.freeze({
    event: "authorization_result",
    status: snapshot.status,
  });
}

function parseLine(line: string, ordinal: number) {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_STDOUT_BYTES) {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("USER_AUTH_PROTOCOL_INVALID");
  }
  return ordinal === 0
    ? parseAuthorizationUrl(parsed)
    : parseAuthorizationResult(parsed);
}

function validMissingScopes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64 ||
    new Set(value).size !== value.length ||
    value.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  ) {
    throw new Error("USER_AUTH_INSPECTION_INVALID");
  }
  return Object.freeze([...value]);
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return Object.freeze({ promise, resolve: resolveValue });
}

export function createRuntimeUserAuthorizationFlow(
  dependencies: RuntimeUserAuthorizationFlowDependencies,
): RuntimeUserAuthorizationFlow {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    typeof dependencies.inspect !== "function" ||
    typeof dependencies.startHelper !== "function" ||
    typeof dependencies.sendAuthorizationCard !== "function" ||
    typeof dependencies.sendText !== "function"
  ) {
    throw new Error("USER_AUTH_DEPENDENCIES_INVALID");
  }

  let active: ActiveFlow | undefined;
  let activeHelper: RuntimeUserAuthHelperHandle | undefined;
  let closing = false;
  let appScopeNoticeSent = false;

  const runHelper = async (
    route: RuntimeUserAuthorizationRoute,
    missingScopes: readonly string[],
  ): Promise<void> => {
    let authorizationCardSent = false;
    let completed = false;
    let handle: RuntimeUserAuthHelperHandle | undefined;
    try {
      handle = await dependencies.startHelper(missingScopes);
      activeHelper = handle;
      let buffered = Buffer.alloc(0);
      let lineCount = 0;
      let resultEvent: AuthorizationResultEvent | undefined;
      for await (const chunk of handle.stdout) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("USER_AUTH_PROTOCOL_INVALID");
        }
        buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
        if (buffered.length > MAX_STDOUT_BYTES) {
          throw new Error("USER_AUTH_PROTOCOL_INVALID");
        }
        for (;;) {
          const newline = buffered.indexOf(0x0a);
          if (newline < 0) break;
          const lineBytes = buffered.subarray(0, newline);
          buffered = buffered.subarray(newline + 1);
          if (lineBytes.at(-1) === 0x0d) {
            throw new Error("USER_AUTH_PROTOCOL_INVALID");
          }
          if (lineCount >= MAX_PROTOCOL_LINES) {
            throw new Error("USER_AUTH_PROTOCOL_INVALID");
          }
          const line = new TextDecoder("utf-8", { fatal: true }).decode(
            lineBytes,
          );
          const event = parseLine(line, lineCount);
          lineCount += 1;
          if (event.event === "authorization_url") {
            if (closing) throw new Error("USER_AUTH_FLOW_CLOSED");
            await dependencies.sendAuthorizationCard(
              Object.freeze({
                ...route,
                authorizationUrl: event.url,
              }),
            );
            authorizationCardSent = true;
          } else {
            resultEvent = event;
          }
        }
      }
      if (buffered.length !== 0 || lineCount !== MAX_PROTOCOL_LINES) {
        throw new Error("USER_AUTH_PROTOCOL_INVALID");
      }
      const processResult = await handle.result;
      completed =
        resultEvent?.status === "complete" &&
        processResult.exitCode === 0 &&
        processResult.signal === null;
      if (
        !completed &&
        !(
          resultEvent?.status === "blocked" &&
          processResult.exitCode !== 0 &&
          processResult.signal === null
        )
      ) {
        throw new Error("USER_AUTH_RESULT_INVALID");
      }
    } catch {
      await handle?.stop().catch(() => undefined);
      completed = false;
    } finally {
      if (activeHelper === handle) activeHelper = undefined;
    }
    if (closing) return;
    await dependencies.sendText(
      Object.freeze({
        ...route,
        text: completed
          ? "授权完成，请重新发送原任务。"
          : "授权未完成，请稍后重新发送原任务。",
      }),
    );
    if (!authorizationCardSent && completed) {
      throw new Error("USER_AUTH_CARD_NOT_SENT");
    }
  };

  const start = (routeValue: RuntimeUserAuthorizationRoute): ActiveFlow => {
    const route = exactRoute(routeValue);
    const decision = deferred<RuntimeUserAuthorizationDecision>();
    const completion = (async () => {
      try {
        const inspection = await dependencies.inspect();
        if (
          inspection === null ||
          typeof inspection !== "object" ||
          typeof inspection.state !== "string"
        ) {
          throw new Error("USER_AUTH_INSPECTION_INVALID");
        }
        if (inspection.state === "READY") {
          decision.resolve(Object.freeze({ state: "READY" as const }));
          return;
        }
        if (inspection.state === "APP_SCOPE_MISSING") {
          decision.resolve(
            Object.freeze({ state: "BLOCKED_APP_SCOPE" as const }),
          );
          if (!appScopeNoticeSent) {
            appScopeNoticeSent = true;
            await dependencies.sendText(
              Object.freeze({
                ...route,
                text: "应用后台权限尚未开通，请联系交付人员处理。",
              }),
            );
          }
          return;
        }
        if (inspection.state !== "USER_AUTH_REQUIRED") {
          throw new Error("USER_AUTH_INSPECTION_INVALID");
        }
        const missingScopes = validMissingScopes(inspection.missingScopes);
        decision.resolve(
          Object.freeze({ state: "AUTHORIZATION_REQUIRED" as const }),
        );
        await runHelper(route, missingScopes);
      } catch {
        decision.resolve(
          Object.freeze({ state: "AUTHORIZATION_REQUIRED" as const }),
        );
        if (!closing) {
          await dependencies
            .sendText(
              Object.freeze({
                ...route,
                text: "授权未完成，请稍后重新发送原任务。",
              }),
            )
            .catch(() => undefined);
        }
      }
    })().finally(() => {
      if (active?.completion === completion) active = undefined;
    });
    return Object.freeze({ decision: decision.promise, completion });
  };

  return Object.freeze({
    ensureAuthorized(route) {
      if (closing) {
        return Promise.resolve(Object.freeze({ state: "CLOSED" as const }));
      }
      active ??= start(route);
      return active.decision;
    },
    async waitForIdle() {
      while (active) await active.completion;
    },
    async close() {
      if (closing) return;
      closing = true;
      await activeHelper?.stop().catch(() => undefined);
      await active?.completion.catch(() => undefined);
    },
  });
}
