import type { GrafanaConfig } from '../types.js';
import { type GrafanaDatasource, listGrafanaDatasources } from './grafana.js';

// Grafana datasource UIDs that are fixed across environments (Grafanas are
// provisioned with deterministic UIDs).
export const PROMETHEUS_THANOS_UID = 'P7C88DFFA3330979B'; // "All Prometheus regions (Thanos)"
export const POSTGRES_UID = 'PDD8BC545CD76D0F3'; // "PostgreSQL (Grafana)" — exposes deployer schema

// Grafana provisions one Prometheus datasource per region, named
// `Prometheus (<region>)` (e.g. `Prometheus (us-east-1)`), alongside the
// cross-region `All Prometheus regions (Thanos)`. Dashboards reference them by
// UID, so a region-correct deep link needs a name -> UID lookup. The UIDs are
// deterministic per Grafana instance but differ per region, so they are
// resolved at runtime rather than baked into a table that would drift as
// regions are added.
const regionalPrometheusName = (region: string): string =>
  `Prometheus (${region})`;

const CACHE_TTL_MS = 5 * 60_000;

let cache: { fetchedAt: number; datasources: GrafanaDatasource[] } | null =
  null;

const datasources = async (
  config: GrafanaConfig,
  now: number,
): Promise<GrafanaDatasource[]> => {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.datasources;
  }
  const fetched = await listGrafanaDatasources(config);
  cache = { fetchedAt: now, datasources: fetched };
  return fetched;
};

export const resetDatasourceCache = (): void => {
  cache = null;
};

/**
 * UID of the Prometheus datasource scoped to `region`, or null when Grafana has
 * no datasource by that name. Returning null rather than throwing lets callers
 * emit a link that falls back to the dashboard's own default datasource, which
 * is degraded but still useful, instead of failing the whole request.
 */
export const prometheusDatasourceUidForRegion = async (
  config: GrafanaConfig,
  region: string,
  now: number = Date.now(),
): Promise<string | null> => {
  const wanted = regionalPrometheusName(region).toLowerCase();
  const found = (await datasources(config, now)).find(
    (datasource) =>
      datasource.type === 'prometheus' &&
      datasource.name.toLowerCase() === wanted,
  );
  return found?.uid ?? null;
};
