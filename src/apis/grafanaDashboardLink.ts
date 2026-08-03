import type { ApiFactory, InferSchema } from '@tigerdata/mcp-boilerplate';
import { z } from 'zod';
import {
  buildDashboardUrl,
  DASHBOARD_KEYS,
  DASHBOARDS,
  type DashboardKey,
} from '../dashboards.js';
import type { ServerContext } from '../types.js';
import { resolveDashboardContext } from '../util/dashboardContext.js';

const DEFAULT_FROM = 'now-2d';
const DEFAULT_TO = 'now';

const dashboardChoices = DASHBOARD_KEYS.map(
  (key) => `${key} (${DASHBOARDS[key].description})`,
).join('; ');

const inputSchema = {
  projectId: z.string().describe('The project ID.'),
  serviceId: z.string().describe('The service ID.'),
  dashboard: z
    .enum(DASHBOARD_KEYS)
    .describe(`Which dashboard to link to. ${dashboardChoices}`),
  region: z
    .string()
    .optional()
    .describe(
      'Region override, e.g. "eu-central-1". Omit to resolve it from the service\'s own metrics; pass it when the service has stopped reporting.',
    ),
  from: z
    .string()
    .optional()
    .describe(`Start of the time range. Defaults to "${DEFAULT_FROM}".`),
  to: z
    .string()
    .optional()
    .describe(`End of the time range. Defaults to "${DEFAULT_TO}".`),
} as const;

const outputSchema = {
  dashboardUrl: z
    .string()
    .describe('Grafana deep link with every resolvable template variable set.'),
  dashboard: z.string().describe('The dashboard key that was linked.'),
  title: z.string().describe('Human-readable dashboard title.'),
  region: z
    .string()
    .nullable()
    .describe('Region the service was resolved to, e.g. "eu-central-1".'),
  variables: z
    .record(z.string(), z.string())
    .describe('Template variables set on the link, for auditing.'),
  omittedVariables: z
    .array(z.string())
    .describe(
      'Template variables that could not be resolved and were left to the dashboard default.',
    ),
  warnings: z
    .array(z.string())
    .describe('Explanations for anything that could not be resolved.'),
} as const;

type OutputSchema = InferSchema<typeof outputSchema>;

export const grafanaDashboardLink: ApiFactory<
  ServerContext,
  typeof inputSchema,
  typeof outputSchema
> = (ctx) => ({
  name: 'grafana_dashboard_link',
  method: 'post',
  route: '/grafana-dashboard-link',
  config: {
    title: 'Grafana Dashboard Link',
    description:
      'Build a region-correct Grafana deep link to a per-service dashboard (user instance, Postgres livesync connector, connection pooler, Tigerlake, connector K8s events). Resolves the service region, primary member pod, connector container, and the region-scoped Prometheus datasource from live metrics rather than assuming them.',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  fn: async ({
    projectId,
    serviceId,
    dashboard,
    region,
    from,
    to,
  }): Promise<OutputSchema> => {
    const definition = DASHBOARDS[dashboard as DashboardKey];

    const { context, warnings } = await resolveDashboardContext(ctx, {
      projectId,
      serviceId,
      region,
      needsConnector: definition.needsConnector,
    });

    const { url, vars, missing } = buildDashboardUrl(
      ctx.grafana.publicUrl,
      definition,
      context,
      { from: from ?? DEFAULT_FROM, to: to ?? DEFAULT_TO },
    );

    return {
      dashboardUrl: url,
      dashboard,
      title: definition.title,
      region: context.region,
      variables: vars,
      omittedVariables: missing,
      warnings,
    };
  },
});
