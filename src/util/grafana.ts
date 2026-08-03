import type { GrafanaConfig } from '../types.js';

export type GrafanaFrame = {
  schema?: {
    refId?: string;
    fields?: Array<{
      name: string;
      type?: string;
      labels?: Record<string, string>;
    }>;
  };
  data?: {
    values?: unknown[][];
  };
};

export type GrafanaQueryResult = {
  status?: number;
  frames?: GrafanaFrame[];
};

export type GrafanaDataFrameResponse = {
  results?: Record<string, GrafanaQueryResult>;
};

export const getValues = (
  response: GrafanaDataFrameResponse,
  refId: string,
): unknown[][] | null =>
  response.results?.[refId]?.frames?.[0]?.data?.values ?? null;

// Prometheus instant queries carry the series' label set on the value field of
// the first frame. `max by (...)` in the query decides which labels survive.
export const getLabels = (
  response: GrafanaDataFrameResponse,
  refId: string,
): Record<string, string> | null => {
  const fields = response.results?.[refId]?.frames?.[0]?.schema?.fields ?? [];
  for (const field of fields) {
    if (field.labels && Object.keys(field.labels).length > 0) {
      return field.labels;
    }
  }
  return null;
};

// PromQL label matchers are double-quoted strings: backslashes and quotes have
// to be escaped or the query is rejected (or, worse, silently reinterpreted).
export const promLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const requestGrafanaJson = async <Response = unknown>(
  config: GrafanaConfig,
  path: string,
  init: RequestInit,
  what: string,
): Promise<Response> => {
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.serviceAccountToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      const contentType = response.headers.get('content-type') ?? 'unknown';
      const snippet = text.slice(0, 200);
      throw new Error(
        `Grafana returned non-JSON response (${response.status}, ${contentType}): ${snippet}`,
      );
    }
  }

  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : text;
    throw new Error(`Grafana ${what} failed (${response.status}): ${message}`);
  }

  return body as Response;
};

export const queryGrafanaDatasource = async <Response = unknown>(
  config: GrafanaConfig,
  payload: Record<string, unknown>,
): Promise<Response> =>
  requestGrafanaJson<Response>(
    config,
    '/api/ds/query',
    { method: 'POST', body: JSON.stringify(payload) },
    'query',
  );

export type GrafanaDatasource = {
  uid: string;
  name: string;
  type: string;
};

export const listGrafanaDatasources = async (
  config: GrafanaConfig,
): Promise<GrafanaDatasource[]> =>
  requestGrafanaJson<GrafanaDatasource[]>(
    config,
    '/api/datasources',
    { method: 'GET' },
    'datasource listing',
  );

export const queryGrafanaPostgresQueries = async (
  config: GrafanaConfig,
  {
    datasourceUid,
    queries,
  }: {
    datasourceUid: string;
    queries: Array<{
      refId: string;
      sql: string;
    }>;
  },
): Promise<GrafanaDataFrameResponse> =>
  queryGrafanaDatasource<GrafanaDataFrameResponse>(config, {
    from: 'now-1h',
    to: 'now',
    queries: queries.map(({ refId, sql }) => ({
      refId,
      datasource: {
        type: 'postgres',
        uid: datasourceUid,
      },
      datasourceUid,
      format: 'table',
      rawSql: sql,
    })),
  });

export const queryGrafanaPrometheusQueries = async (
  config: GrafanaConfig,
  {
    datasourceUid,
    queries,
    from = 'now-5m',
    to = 'now',
    instant = true,
    range = false,
  }: {
    datasourceUid: string;
    queries: Array<{
      refId: string;
      expr: string;
    }>;
    from?: string;
    to?: string;
    instant?: boolean;
    range?: boolean;
  },
): Promise<GrafanaDataFrameResponse> =>
  queryGrafanaDatasource<GrafanaDataFrameResponse>(config, {
    from,
    to,
    queries: queries.map(({ refId, expr }) => ({
      refId,
      datasource: {
        type: 'prometheus',
        uid: datasourceUid,
      },
      expr,
      instant,
      range,
    })),
  });
