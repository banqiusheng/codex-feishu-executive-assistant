import type { JsonValue } from "../ipc/framing.js";

export type LarkCliRequest = Readonly<{
  version: 1;
  operation: string;
  payload: Readonly<Record<string, JsonValue>>;
}>;

export type LarkCliRunResult =
  | Readonly<{ state: "SUCCEEDED"; value: JsonValue }>
  | Readonly<{
      state: "FAILED";
      code:
        | "EXECUTABLE_REJECTED"
        | "SPAWN_FAILED"
        | "CLI_EXITED"
        | "OUTPUT_LIMIT"
        | "OUTPUT_INVALID";
    }>
  | Readonly<{
      state: "UNKNOWN";
      code: "TIMEOUT" | "IO_AFTER_SPAWN" | "TERMINATION_UNCONFIRMED";
    }>;
