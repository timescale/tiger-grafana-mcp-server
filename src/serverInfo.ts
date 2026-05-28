import { GRAFANA_PUBLIC_URL } from './data_sources.js';
import type { ServerContext } from './types.js';

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const serverInfo = {
  name: 'tiger-grafana',
  version: '0.1.0',
} as const;

export const context: ServerContext = {
  grafana: {
    url: requiredEnv('GRAFANA_URL').replace(/\/+$/, ''),
    publicUrl: GRAFANA_PUBLIC_URL,
    serviceAccountToken: requiredEnv('GRAFANA_SERVICE_ACCOUNT_TOKEN'),
  },
};
