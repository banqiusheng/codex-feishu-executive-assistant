export const ASSISTANT_RUNTIME_PORTS_REQUIRED =
  "ASSISTANT_RUNTIME_PORTS_REQUIRED" as const;

export interface StartOptions {
  config?: string;
  skipCheckLarkCli?: boolean;
}

export async function runStart(_options: StartOptions): Promise<never> {
  throw new Error(ASSISTANT_RUNTIME_PORTS_REQUIRED);
}
