import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { ServerContext } from '../types.js';
import { resetDatasourceCache } from '../util/datasources.js';
import { grafanaDashboardLink } from './grafanaDashboardLink.js';

const context: ServerContext = {
  grafana: {
    url: 'https://grafana.example.com',
    publicUrl: 'https://grafana.example.com',
    logHostTemplate: 'log.prod-{region}.ops.forge.timescale.com',
    serviceAccountToken: 'token',
  },
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const DATASOURCES = [
  {
    uid: 'P7C88DFFA3330979B',
    name: 'All Prometheus regions (Thanos)',
    type: 'prometheus',
  },
  {
    uid: 'P06D2DA4239B6BF57',
    name: 'Prometheus (eu-central-1)',
    type: 'prometheus',
  },
  {
    uid: 'P7BFACEA27D7DF090',
    name: 'Prometheus (us-east-1)',
    type: 'prometheus',
  },
];

const labelledFrame = (refId: string, labels: Record<string, string>) => ({
  status: 200,
  frames: [
    {
      schema: {
        refId,
        fields: [
          { name: 'Time', type: 'time' },
          { name: 'Value', type: 'number', labels },
        ],
      },
      data: { values: [[1779351105410], [1]] },
    },
  ],
});

// A service running a Postgres source connector. The connector's own pod is
// `<service>-pgsrc-connector-<hash>`, but the dashboard's `pod` variable wants
// the Postgres member, `<service>-an-<ordinal>`.
const SERVICE_METRICS = {
  instance: labelledFrame('instance', {
    region: 'eu-central-1',
    node_name: 'jzfulctix1-an',
    ordinal: '0',
  }),
  connector: labelledFrame('connector', {
    region: 'eu-central-1',
    container: 'pgsrc-connector',
  }),
};

const mockFetch = (
  results: Record<string, unknown> = SERVICE_METRICS,
  datasources: unknown = DATASOURCES,
) =>
  mock.method(globalThis, 'fetch', async (url: unknown, init: unknown) => {
    if (String(url).endsWith('/api/datasources')) {
      return jsonResponse(datasources);
    }
    const payload = JSON.parse(String((init as RequestInit).body));
    const refIds: string[] = payload.queries.map(
      (query: { refId: string }) => query.refId,
    );
    return jsonResponse({
      results: Object.fromEntries(
        Object.entries(results).filter(([refId]) => refIds.includes(refId)),
      ),
    });
  });

describe('grafanaDashboardLink', () => {
  beforeEach(() => {
    resetDatasourceCache();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('builds a fully parameterised livesync connector link', async () => {
    mockFetch();

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'pg-connector',
    });

    assert.equal(
      result.dashboardUrl,
      'https://grafana.example.com/d/ce903ba2-882e-48e4-b474-e8f34fc197cf/postgres-livesync-single-user' +
        '?orgId=1&from=now-2d&to=now&timezone=utc' +
        '&var-project_id=kbq0mbo1jb&var-service_id=jzfulctix1' +
        '&var-region=eu-central-1&var-prom_region=P06D2DA4239B6BF57' +
        '&var-app_name=pgsrc-connector&var-pod=jzfulctix1-an-0' +
        '&var-log_url=log.prod-eu-central-1.ops.forge.timescale.com',
    );
    assert.equal(result.region, 'eu-central-1');
    assert.deepEqual(result.omittedVariables, []);
    assert.deepEqual(result.warnings, []);
  });

  it('puts the human region and the datasource UID in the right variables per dashboard', async () => {
    mockFetch();
    const tool = await grafanaDashboardLink(context, {});

    const connector = new URL(
      (
        await tool.fn({
          projectId: 'kbq0mbo1jb',
          serviceId: 'jzfulctix1',
          dashboard: 'pg-connector',
        })
      ).dashboardUrl,
    );
    // Connector dashboard: region is the human name, UID lives in prom_region.
    assert.equal(connector.searchParams.get('var-region'), 'eu-central-1');
    assert.equal(
      connector.searchParams.get('var-prom_region'),
      'P06D2DA4239B6BF57',
    );

    resetDatasourceCache();
    const instance = new URL(
      (
        await tool.fn({
          projectId: 'kbq0mbo1jb',
          serviceId: 'jzfulctix1',
          dashboard: 'user-instance',
        })
      ).dashboardUrl,
    );
    // User-instance dashboard inverts it.
    assert.equal(instance.searchParams.get('var-region'), 'P06D2DA4239B6BF57');
    assert.equal(instance.searchParams.get('var-plain_region'), 'eu-central-1');
  });

  it('honours an explicit region override and time range', async () => {
    mockFetch({
      instance: labelledFrame('instance', {
        region: 'eu-central-1',
        node_name: 'jzfulctix1-an',
        ordinal: '0',
      }),
    });

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'user-instance',
      region: 'us-east-1',
      from: 'now-7d',
      to: 'now-1d',
    });

    const url = new URL(result.dashboardUrl);
    assert.equal(result.region, 'us-east-1');
    assert.equal(url.searchParams.get('var-region'), 'P7BFACEA27D7DF090');
    assert.equal(url.searchParams.get('var-plain_region'), 'us-east-1');
    assert.equal(
      url.searchParams.get('var-log_url'),
      'log.prod-us-east-1.ops.forge.timescale.com',
    );
    assert.equal(url.searchParams.get('from'), 'now-7d');
    assert.equal(url.searchParams.get('to'), 'now-1d');
  });

  it('warns instead of guessing when the service runs no connector', async () => {
    mockFetch({
      instance: labelledFrame('instance', {
        region: 'eu-central-1',
        node_name: 'jzfulctix1-an',
        ordinal: '0',
      }),
    });

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'pg-connector',
    });

    assert.deepEqual(result.omittedVariables, ['app_name']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /no Postgres source connector/i);
    assert.equal(
      new URL(result.dashboardUrl).searchParams.get('var-app_name'),
      null,
    );
  });

  it('warns when Grafana has no datasource for the resolved region', async () => {
    mockFetch(SERVICE_METRICS, [
      {
        uid: 'P7C88DFFA3330979B',
        name: 'All Prometheus regions (Thanos)',
        type: 'prometheus',
      },
    ]);

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'pg-connector',
    });

    assert.deepEqual(result.omittedVariables, ['prom_region']);
    assert.match(
      result.warnings.join('\n'),
      /no Prometheus datasource named "Prometheus \(eu-central-1\)"/,
    );
  });

  it('warns about the missing token scope when it cannot list datasources', async () => {
    mock.method(globalThis, 'fetch', async (url: unknown, init: unknown) => {
      if (String(url).endsWith('/api/datasources')) {
        return new Response(JSON.stringify({ message: 'Permission denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      const payload = JSON.parse(String((init as RequestInit).body));
      const refIds: string[] = payload.queries.map(
        (query: { refId: string }) => query.refId,
      );
      return jsonResponse({
        results: Object.fromEntries(
          Object.entries(SERVICE_METRICS).filter(([refId]) =>
            refIds.includes(refId),
          ),
        ),
      });
    });

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'pg-connector',
    });

    // The region still resolves from metrics, so only the datasource UID is lost.
    assert.equal(result.region, 'eu-central-1');
    assert.deepEqual(result.omittedVariables, ['prom_region']);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /datasources:read/);
    assert.match(result.warnings[0] ?? '', /Permission denied/);
  });

  it('still returns a link when metric resolution fails outright', async () => {
    mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (String(url).endsWith('/api/datasources')) {
        return jsonResponse(DATASOURCES);
      }
      throw new Error('thanos unreachable');
    });

    const tool = await grafanaDashboardLink(context, {});
    const result = await tool.fn({
      projectId: 'kbq0mbo1jb',
      serviceId: 'jzfulctix1',
      dashboard: 'pg-connector',
    });

    assert.equal(result.region, null);
    assert.match(
      result.warnings.join('\n'),
      /Could not resolve the service region/,
    );
    assert.equal(
      new URL(result.dashboardUrl).searchParams.get('var-project_id'),
      'kbq0mbo1jb',
    );
  });
});
