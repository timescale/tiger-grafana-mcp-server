import type { ServerContext } from './types.js';

// Browser-accessible Grafana URLs by environment. Selected at startup based
// on the PROD_DEPLOY env var (default: dev).
const DEV_GRAFANA_PUBLIC_URL = 'https://grafana.dev-us-east-1.ops.dev.timescale.com';
const PROD_GRAFANA_PUBLIC_URL = 'https://grafana.prod-us-east-1.ops.forge.timescale.com';

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const isProdDeploy = (): boolean =>
  (process.env.PROD_DEPLOY ?? '').trim().toLowerCase() === 'true';

export const serverInfo = {
  name: 'tiger-grafana',
  version: '0.1.0',
} as const;

export const context: ServerContext = {
  grafana: {
    url: requiredEnv('GRAFANA_URL').replace(/\/+$/, ''),
    publicUrl: isProdDeploy() ? PROD_GRAFANA_PUBLIC_URL : DEV_GRAFANA_PUBLIC_URL,
    serviceAccountToken: requiredEnv('GRAFANA_SERVICE_ACCOUNT_TOKEN'),
  },
};
