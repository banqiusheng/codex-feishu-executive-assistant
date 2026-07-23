import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log } from '../core/logger';

const HTTP_TIMEOUT_MS = 30_000;

/**
 * Wire up HTTP / WS networking knobs. Called once at startup.
 *
 *  - **HTTP timeout** — mutate SDK's `defaultHttpInstance.defaults.timeout`
 *    so every outbound REST call gets a 30s cap. Without this a slow API
 *    can hang the whole event-handling thread.
 *  - **HTTP(S) proxy** — if `HTTPS_PROXY` / `HTTP_PROXY` env is set, attach
 *    `HttpsProxyAgent` to both axios (`defaults.httpsAgent`) and WSClient
 *    (`channel.opts.agent`, returned for caller to spread).
 *
 * Returns `{ agent }` when proxy is configured (for `LarkChannelOptions.agent`),
 * empty object otherwise.
 */
export interface NetworkOverrides {
  agent?: HttpsProxyAgent<string>;
}

export function configureNetwork(): NetworkOverrides {
  // Mutate SDK's axios instance defaults. The exported HttpInstance type
  // hides axios's `defaults` field, but the runtime IS a full axios.
  const ax = defaultHttpInstance as unknown as {
    defaults: { timeout?: number; httpsAgent?: unknown };
  };
  ax.defaults.timeout = HTTP_TIMEOUT_MS;

  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!proxyUrl) return {};

  const agent = new HttpsProxyAgent(proxyUrl);
  ax.defaults.httpsAgent = agent;
  log.info('network', 'proxy-detected', { proxy: redact(proxyUrl) });

  return { agent };
}

function redact(url: string): string {
  return url.replace(/\/\/[^:@/]+:[^@/]+@/, '//[redacted]@');
}
