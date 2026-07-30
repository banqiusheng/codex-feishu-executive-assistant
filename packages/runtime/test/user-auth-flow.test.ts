import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeUserAuthorizationFlow,
  type RuntimeUserAuthHelperHandle,
} from "../src/user-auth-flow.js";

const ROUTE = Object.freeze({
  chatId: "oc_president",
  replyToMessageId: "om_original",
});
const MISSING_SCOPES = Object.freeze([
  "base:record:read",
  "docx:document:create",
]);

function stream(...lines: readonly string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield Buffer.from(`${line}\n`, "utf8");
      }
    },
  };
}

function helper(
  lines: readonly string[],
  exitCode = 0,
): RuntimeUserAuthHelperHandle {
  return Object.freeze({
    stdout: stream(...lines),
    result: Promise.resolve(
      Object.freeze({ exitCode, signal: null as NodeJS.Signals | null }),
    ),
    stop: vi.fn(async () => undefined),
  });
}

function successfulLines(
  url = "https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=opaque",
) {
  return [
    JSON.stringify({ event: "authorization_url", url }),
    JSON.stringify({ event: "authorization_result", status: "complete" }),
  ];
}

describe("runtime one-click Feishu user authorization", () => {
  it("lets an already-authorized message proceed without spawning or sending a card", async () => {
    const inspect = vi.fn(async () =>
      Object.freeze({ state: "READY" as const }),
    );
    const startHelper = vi.fn();
    const sendAuthorizationCard = vi.fn();
    const sendText = vi.fn();
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper,
      sendAuthorizationCard,
      sendText,
    });

    await expect(flow.ensureAuthorized(ROUTE)).resolves.toEqual({
      state: "READY",
    });
    await flow.waitForIdle();
    expect(startHelper).not.toHaveBeenCalled();
    expect(sendAuthorizationCard).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not start OAuth when developer-console app scopes are missing", async () => {
    const inspect = vi.fn(async () =>
      Object.freeze({ state: "APP_SCOPE_MISSING" as const }),
    );
    const startHelper = vi.fn();
    const sendAuthorizationCard = vi.fn();
    const sendText = vi.fn(async () => undefined);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper,
      sendAuthorizationCard,
      sendText,
    });

    await expect(flow.ensureAuthorized(ROUTE)).resolves.toEqual({
      state: "BLOCKED_APP_SCOPE",
    });
    await expect(flow.ensureAuthorized(ROUTE)).resolves.toEqual({
      state: "BLOCKED_APP_SCOPE",
    });
    expect(startHelper).not.toHaveBeenCalled();
    expect(sendAuthorizationCard).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      ...ROUTE,
      text: "应用后台权限尚未开通，请联系交付人员处理。",
    });
  });

  it("sends one OpenLink card, never relays protocol secrets, and asks the president to resend after success", async () => {
    const authorizationUrl =
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=opaque";
    const inspect = vi.fn(async () =>
      Object.freeze({
        state: "USER_AUTH_REQUIRED" as const,
        missingScopes: MISSING_SCOPES,
      }),
    );
    const startHelper = vi.fn(async () =>
      helper(successfulLines(authorizationUrl)),
    );
    const sendAuthorizationCard = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper,
      sendAuthorizationCard,
      sendText,
    });

    await expect(flow.ensureAuthorized(ROUTE)).resolves.toEqual({
      state: "AUTHORIZATION_REQUIRED",
    });
    await flow.waitForIdle();

    expect(startHelper).toHaveBeenCalledTimes(1);
    expect(startHelper).toHaveBeenCalledWith(MISSING_SCOPES);
    expect(sendAuthorizationCard).toHaveBeenCalledTimes(1);
    expect(sendAuthorizationCard).toHaveBeenCalledWith({
      ...ROUTE,
      authorizationUrl,
    });
    expect(sendText).toHaveBeenCalledWith({
      ...ROUTE,
      text: "授权完成，请重新发送原任务。",
    });
    const outwardText = JSON.stringify(sendText.mock.calls);
    expect(outwardText).not.toContain(authorizationUrl);
    expect(outwardText).not.toMatch(/device|token|cache/i);
  });

  it("shares one helper and one card across concurrent messages", async () => {
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspect = vi.fn(async () => {
      await inspectionGate;
      return Object.freeze({
        state: "USER_AUTH_REQUIRED" as const,
        missingScopes: MISSING_SCOPES,
      });
    });
    const startHelper = vi.fn(async () => helper(successfulLines()));
    const sendAuthorizationCard = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper,
      sendAuthorizationCard,
      sendText,
    });

    const first = flow.ensureAuthorized(ROUTE);
    const second = flow.ensureAuthorized({
      chatId: ROUTE.chatId,
      replyToMessageId: "om_second",
    });
    releaseInspection?.();
    await expect(first).resolves.toEqual({ state: "AUTHORIZATION_REQUIRED" });
    await expect(second).resolves.toEqual({ state: "AUTHORIZATION_REQUIRED" });
    await flow.waitForIdle();

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(startHelper).toHaveBeenCalledTimes(1);
    expect(sendAuthorizationCard).toHaveBeenCalledTimes(1);
  });

  it("ends a blocked flow without looping and permits one later fresh attempt", async () => {
    const inspect = vi.fn(async () =>
      Object.freeze({
        state: "USER_AUTH_REQUIRED" as const,
        missingScopes: MISSING_SCOPES,
      }),
    );
    const startHelper = vi
      .fn()
      .mockResolvedValueOnce(
        helper(
          [
            ...successfulLines().slice(0, 1),
            JSON.stringify({
              event: "authorization_result",
              status: "blocked",
            }),
          ],
          1,
        ),
      )
      .mockResolvedValueOnce(helper(successfulLines()));
    const sendAuthorizationCard = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper,
      sendAuthorizationCard,
      sendText,
    });

    await flow.ensureAuthorized(ROUTE);
    await flow.waitForIdle();
    expect(startHelper).toHaveBeenCalledTimes(1);
    expect(sendAuthorizationCard).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      ...ROUTE,
      text: "授权未完成，请稍后重新发送原任务。",
    });

    await flow.ensureAuthorized(ROUTE);
    await flow.waitForIdle();
    expect(startHelper).toHaveBeenCalledTimes(2);
    expect(sendAuthorizationCard).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong origin", successfulLines("https://evil.example/authorize"), 0],
    [
      "callback-like extra data",
      [
        JSON.stringify({
          event: "authorization_url",
          url: "https://accounts.feishu.cn/authorize",
          callback: "forbidden",
        }),
        successfulLines()[1]!,
      ],
      0,
    ],
  ])(
    "fails closed on %s without exposing the URL in text",
    async (_name, lines, exitCode) => {
      const inspect = vi.fn(async () =>
        Object.freeze({
          state: "USER_AUTH_REQUIRED" as const,
          missingScopes: MISSING_SCOPES,
        }),
      );
      const sendAuthorizationCard = vi.fn(async () => undefined);
      const sendText = vi.fn(async () => undefined);
      const flow = createRuntimeUserAuthorizationFlow({
        inspect,
        startHelper: async () => helper(lines, exitCode),
        sendAuthorizationCard,
        sendText,
      });

      await flow.ensureAuthorized(ROUTE);
      await flow.waitForIdle();

      expect(sendAuthorizationCard).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledWith({
        ...ROUTE,
        text: "授权未完成，请稍后重新发送原任务。",
      });
      expect(JSON.stringify(sendText.mock.calls)).not.toContain(
        "accounts.feishu.cn",
      );
    },
  );

  it.each([
    [
      "an extra line after the card was presented",
      [
        successfulLines()[0]!,
        successfulLines()[1]!,
        JSON.stringify({ event: "extra" }),
      ],
      0,
    ],
    ["a nonzero helper exit after presentation", successfulLines(), 1],
  ])("does not claim success after %s", async (_name, lines, exitCode) => {
    const inspect = vi.fn(async () =>
      Object.freeze({
        state: "USER_AUTH_REQUIRED" as const,
        missingScopes: MISSING_SCOPES,
      }),
    );
    const sendAuthorizationCard = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect,
      startHelper: async () => helper(lines, exitCode),
      sendAuthorizationCard,
      sendText,
    });

    await flow.ensureAuthorized(ROUTE);
    await flow.waitForIdle();

    expect(sendAuthorizationCard).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      ...ROUTE,
      text: "授权未完成，请稍后重新发送原任务。",
    });
    expect(sendText).not.toHaveBeenCalledWith({
      ...ROUTE,
      text: "授权完成，请重新发送原任务。",
    });
  });
});
