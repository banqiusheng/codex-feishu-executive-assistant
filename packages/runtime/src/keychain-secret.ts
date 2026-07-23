import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

import type { BotSecretProvider, RuntimeSecretRef } from "./types.js";

const SECURITY_PATH = "/usr/bin/security";
const MAX_SECRET_BYTES = 4_096;
const KEYCHAIN_TIMEOUT_MS = 5_000;

interface KeychainChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    env: Readonly<Record<string, string>>;
    shell: false;
    stdio: readonly ["ignore", "pipe", "pipe"];
  }>,
) => KeychainChild;

export type MacOsKeychainProviderOptions = Readonly<{
  securityPath?: string;
  spawn?: Spawn;
}>;

export function createMacOsKeychainSecretProvider(
  options: MacOsKeychainProviderOptions = {},
): BotSecretProvider {
  const securityPath = options.securityPath ?? SECURITY_PATH;
  if (!isAbsolute(securityPath) || securityPath.includes("\0")) {
    throw new Error("KEYCHAIN_SECURITY_PATH_INVALID");
  }
  const spawn = options.spawn ?? (nodeSpawn as Spawn);
  return Object.freeze({
    async load(appId: string, secretRef: RuntimeSecretRef): Promise<string> {
      if (secretRef.type !== "macos-keychain" || secretRef.account !== appId) {
        throw new Error("KEYCHAIN_SECRET_REF_INVALID");
      }
      return new Promise<string>((resolve, reject) => {
        let child: KeychainChild;
        try {
          child = spawn(
            securityPath,
            [
              "find-generic-password",
              "-w",
              "-s",
              secretRef.service,
              "-a",
              secretRef.account,
            ],
            {
              env: Object.freeze({
                PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              }),
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
        } catch {
          reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE"));
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        let settled = false;
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          operation();
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE")));
        }, KEYCHAIN_TIMEOUT_MS);
        timer.unref();
        child.stdout.on("data", (chunk: Buffer) => {
          byteLength += chunk.byteLength;
          if (byteLength > MAX_SECRET_BYTES) {
            child.kill("SIGKILL");
            finish(() => reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE")));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        child.stdout.on("error", () => {
          finish(() => reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE")));
        });
        child.stderr.resume();
        child.on("error", () => {
          finish(() => reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE")));
        });
        child.on("close", (code, signal) => {
          finish(() => {
            if (code !== 0 || signal !== null) {
              reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE"));
              return;
            }
            const secret = Buffer.concat(chunks).toString("utf8").trim();
            if (
              secret.length === 0 ||
              Buffer.byteLength(secret) > MAX_SECRET_BYTES
            ) {
              reject(new Error("KEYCHAIN_SECRET_UNAVAILABLE"));
              return;
            }
            resolve(secret);
          });
        });
      });
    },
  });
}
