import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { ServerContext } from '../types.js';
import { resetDatasourceCache } from '../util/datasources.js';
import { userInstanceBasicInformation } from './userInstanceBasicInformation.js';

const context: ServerContext = {
  grafana: {
    url: 'https://grafana.example.com',
    publicUrl: 'https://grafana.example.com',
    logHostTemplate: 'log.prod-{region}.ops.forge.timescale.com',
    serviceAccountToken: 'token',
  },
};

const grafanaResponse = (
  refId: string,
  values: unknown[][],
): { results: Record<string, unknown> } => ({
  results: {
    [refId]: {
      status: 200,
      frames: [
        {
          data: {
            values,
          },
        },
      ],
    },
  },
});

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
];

const locationResponse = jsonResponse({
  results: {
    instance: {
      status: 200,
      frames: [
        {
          schema: {
            refId: 'instance',
            fields: [
              { name: 'Time', type: 'time' },
              {
                name: 'Value',
                type: 'number',
                labels: {
                  region: 'eu-central-1',
                  node_name: 'forkh6059q-an',
                  ordinal: '0',
                },
              },
            ],
          },
          data: { values: [[1779351105410], [180004]] },
        },
      ],
    },
  },
});

// Dispatch on request content rather than call order: the version, extension,
// and location queries are issued concurrently.
const responseForRequest = (url: string, init: RequestInit): Response => {
  if (url.endsWith('/api/datasources')) {
    return jsonResponse(DATASOURCES);
  }

  const payload = JSON.parse(String(init.body));
  const refIds = payload.queries.map((query: { refId: string }) => query.refId);

  if (refIds.includes('major')) {
    return jsonResponse({
      results: {
        major: grafanaResponse('major', [[1779351105410], [18.0003]]).results
          .major,
        minor: grafanaResponse('minor', [[1779351105422], [3]]).results.minor,
      },
    });
  }
  if (refIds.includes('instance')) {
    return locationResponse.clone();
  }

  return jsonResponse(grafanaResponse('timescaledb', [['2.27.0']]));
};

const mockFetch = () =>
  mock.method(globalThis, 'fetch', async (url: unknown, init: unknown) =>
    responseForRequest(String(url), init as RequestInit),
  );

const bodiesFor = (
  fetchMock: ReturnType<typeof mockFetch>,
  refId: string,
): Array<Record<string, unknown>> =>
  fetchMock.mock.calls
    .map((call) => call.arguments as [string, RequestInit])
    .filter(([, init]) => typeof init.body === 'string')
    .map(([, init]) => JSON.parse(String(init.body)))
    .filter((payload) =>
      payload.queries.some((query: { refId: string }) => query.refId === refId),
    );

describe('userInstanceBasicInformation', () => {
  beforeEach(() => {
    // The datasource lookup is cached process-wide.
    resetDatasourceCache();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('returns versions and a region-scoped dashboard link', async () => {
    const fetchMock = mockFetch();

    const tool = await userInstanceBasicInformation(context, {});
    const result = await tool.fn({
      projectId: 'a90edkib9o',
      serviceId: 'forkh6059q',
    });

    assert.deepEqual(result, {
      postgresqlVersion: '18.3',
      timescaledbVersion: '2.27.0',
      region: 'eu-central-1',
      dashboardUrl:
        'https://grafana.example.com/d/3lvO6U-Zz/user-instance-single' +
        '?orgId=1&from=now-24h&to=now&timezone=utc' +
        '&var-project=a90edkib9o&var-service=forkh6059q' +
        '&var-plain_region=eu-central-1&var-region=P06D2DA4239B6BF57' +
        '&var-log_url=log.prod-eu-central-1.ops.forge.timescale.com',
    });

    // Versions, extension, location, plus the datasource lookup.
    assert.equal(fetchMock.mock.callCount(), 4);
    assert.equal(bodiesFor(fetchMock, 'major').length, 1);
    assert.equal(bodiesFor(fetchMock, 'timescaledb').length, 1);
    assert.equal(bodiesFor(fetchMock, 'instance').length, 1);
  });

  it('does not ask for connector metrics', async () => {
    const fetchMock = mockFetch();

    const tool = await userInstanceBasicInformation(context, {});
    await tool.fn({ projectId: 'a90edkib9o', serviceId: 'forkh6059q' });

    assert.equal(bodiesFor(fetchMock, 'connector').length, 0);
  });

  it('escapes project and service IDs in both query languages', async () => {
    const fetchMock = mockFetch();

    const tool = await userInstanceBasicInformation(context, {});
    await tool.fn({
      projectId: 'project\'"id',
      serviceId: 'service\'"id',
    });

    const [sql] = bodiesFor(fetchMock, 'timescaledb');
    assert.ok(sql);
    const rawSql = String(
      (sql.queries as Array<{ rawSql: string }>)[0]?.rawSql,
    );
    assert.match(rawSql, /project_id = 'project''"id'/);
    assert.match(rawSql, /service_id = 'service''"id'/);

    const [prom] = bodiesFor(fetchMock, 'major');
    assert.ok(prom);
    const expr = String((prom.queries as Array<{ expr: string }>)[0]?.expr);
    assert.match(expr, /projectid="project'\\"id"/);
    assert.match(expr, /serviceid="service'\\"id"/);
  });

  it('omits region-scoped variables when the service has no metrics', async () => {
    mock.method(globalThis, 'fetch', async (url: unknown, init: unknown) => {
      const asString = String(url);
      if (asString.endsWith('/api/datasources')) {
        return jsonResponse(DATASOURCES);
      }
      const payload = JSON.parse(String((init as RequestInit).body));
      const refIds = payload.queries.map(
        (query: { refId: string }) => query.refId,
      );
      if (refIds.includes('instance')) {
        return jsonResponse({ results: {} });
      }
      return responseForRequest(asString, init as RequestInit);
    });

    const tool = await userInstanceBasicInformation(context, {});
    const result = await tool.fn({
      projectId: 'a90edkib9o',
      serviceId: 'forkh6059q',
    });

    assert.equal(result.region, null);
    const url = new URL(result.dashboardUrl);
    assert.equal(url.searchParams.get('var-project'), 'a90edkib9o');
    assert.equal(url.searchParams.get('var-plain_region'), null);
    assert.equal(url.searchParams.get('var-region'), null);
    assert.equal(url.searchParams.get('var-log_url'), null);
  });
});
