import type { DashboardContext } from '../dashboards.js';
import type { ServerContext } from '../types.js';
import { prometheusDatasourceUidForRegion } from './datasources.js';
import { resolveServiceLocation } from './serviceLocation.js';

/**
 * Resolve the values a dashboard's template variables need for one service.
 *
 * Everything is best-effort: whatever cannot be resolved comes back null with a
 * warning explaining which variable will fall back to the dashboard default,
 * so a partially-resolvable service still yields a usable link.
 */
export const resolveDashboardContext = async (
  ctx: ServerContext,
  {
    projectId,
    serviceId,
    region,
    needsConnector,
  }: {
    projectId: string;
    serviceId: string;
    /** Explicit region override, skipping metric-based resolution. */
    region?: string;
    needsConnector: boolean;
  },
): Promise<{ context: DashboardContext; warnings: string[] }> => {
  const warnings: string[] = [];

  const location = await resolveServiceLocation(ctx.grafana, {
    projectId,
    serviceId,
    includeConnector: needsConnector,
  });

  const resolvedRegion = region ?? location.region;
  if (!resolvedRegion) {
    warnings.push(
      'Could not resolve the service region from metrics; region-scoped variables were omitted. Pass `region` explicitly if the service has not reported metrics in the last hour.',
    );
  }
  if (needsConnector && !location.connectorContainer) {
    warnings.push(
      'No Postgres source connector metrics found for this service in the last hour; `app_name` was omitted. The service may not run a connector.',
    );
  }

  let promDatasourceUid: string | null = null;
  if (resolvedRegion) {
    let listed = true;
    try {
      promDatasourceUid = await prometheusDatasourceUidForRegion(
        ctx.grafana,
        resolvedRegion,
      );
    } catch (error) {
      listed = false;
      warnings.push(
        `Could not list Grafana datasources to resolve the ${resolvedRegion} Prometheus UID (the service account token needs datasources:read): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Only claim the datasource is absent when the list was actually read;
    // otherwise a permission error would be reported as a missing datasource.
    if (listed && promDatasourceUid == null) {
      warnings.push(
        `Grafana has no Prometheus datasource named "Prometheus (${resolvedRegion})"; the link falls back to the dashboard's default datasource, which may show another region's data.`,
      );
    }
  }

  return {
    context: {
      projectId,
      serviceId,
      region: resolvedRegion,
      promDatasourceUid,
      logHost: resolvedRegion
        ? ctx.grafana.logHostTemplate.replace('{region}', resolvedRegion)
        : null,
      instancePod: location.instancePod,
      connectorAppName: location.connectorContainer,
    },
    warnings,
  };
};
