import type { GrafanaConfig } from '../types.js';
import { PROMETHEUS_THANOS_UID } from './datasources.js';
import {
  getLabels,
  promLabelValue,
  queryGrafanaPrometheusQueries,
} from './grafana.js';

export type ServiceLocation = {
  // Human region name, e.g. `eu-central-1`. Note this is *not* what every
  // dashboard's `region` variable holds: some expect a datasource UID instead.
  region: string | null;
  // Primary Postgres member pod, e.g. `jzfulctix1-an-0`. This is the database
  // pod, not the connector pod: the livesync dashboard's `pod` variable scopes
  // its instance-side and log panels, so it wants the member, not
  // `<service>-pgsrc-connector-<hash>`.
  instancePod: string | null;
  // Container name of the Postgres source connector, e.g. `pgsrc-connector`.
  // Null when the service has no connector reporting metrics.
  connectorContainer: string | null;
};

const EMPTY: ServiceLocation = {
  region: null,
  instancePod: null,
  connectorContainer: null,
};

// A one-hour lookback tolerates scrape gaps and short restarts without letting
// a long-decommissioned service resolve to a stale region.
const LOOKBACK = '1h';

/**
 * Resolve where a service actually runs from its own metrics, rather than
 * assuming a region or string-building a pod name. Queries Thanos so a single
 * call covers every region.
 *
 * Never throws: an unresolvable field comes back null so callers can degrade to
 * a partially-parameterised dashboard link and report what was missing.
 */
export const resolveServiceLocation = async (
  config: GrafanaConfig,
  {
    projectId,
    serviceId,
    includeConnector = false,
  }: {
    projectId: string;
    serviceId: string;
    includeConnector?: boolean;
  },
): Promise<ServiceLocation> => {
  const project = promLabelValue(projectId);
  const service = promLabelValue(serviceId);

  const queries = [
    {
      refId: 'instance',
      // `node_name` + `ordinal` reconstruct the member pod name; `max by`
      // narrows the label set to exactly the labels being read back.
      expr: `max by (region, node_name, ordinal) (last_over_time(pg_settings_server_version_num{projectid="${project}", serviceid="${service}", role="primary"}[${LOOKBACK}]))`,
    },
  ];
  if (includeConnector) {
    queries.push({
      refId: 'connector',
      expr: `max by (region, container) (last_over_time(livesync_pg_subscriber_source_flush_lsn{cloud_timescale_com_project_id="${project}", cloud_timescale_com_service_id="${service}"}[${LOOKBACK}]))`,
    });
  }

  let response: Awaited<ReturnType<typeof queryGrafanaPrometheusQueries>>;
  try {
    response = await queryGrafanaPrometheusQueries(config, {
      datasourceUid: PROMETHEUS_THANOS_UID,
      queries,
    });
  } catch {
    return EMPTY;
  }

  const instance = getLabels(response, 'instance');
  const connector = includeConnector ? getLabels(response, 'connector') : null;

  const nodeName = instance?.node_name;
  const ordinal = instance?.ordinal;

  return {
    // Prefer the connector's own region when it was queried: it is the region
    // the connector dashboard is about, and it agrees with the instance in
    // every observed case.
    region: connector?.region ?? instance?.region ?? null,
    instancePod: nodeName && ordinal ? `${nodeName}-${ordinal}` : null,
    connectorContainer: connector?.container ?? null,
  };
};
