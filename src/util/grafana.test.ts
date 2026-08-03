import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { GrafanaConfig } from '../types.js';
import {
  getLabels,
  getValues,
  listGrafanaDatasources,
  promLabelValue,
  queryGrafanaDatasource,
  queryGrafanaPostgresQueries,
  queryGrafanaPrometheusQueries,
} from './grafana.js';

const config: GrafanaConfig = {
  url: 'https://grafana.example.com',
  publicUrl: 'https://grafana.example.com',
  logHostTemplate: 'log.prod-{region}.ops.forge.timescale.com',
  serviceAccountToken: 'token',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const postgresVersionFrames = {
  major: {
    status: 200,
    frames: [
      {
        schema: {
          refId: 'major',
          fields: [
            { name: 'Time', type: 'time' },
            { name: 'Value', type: 'number' },
          ],
        },
        data: {
          values: [[1779351105410], [18.0003]],
        },
      },
    ],
  },
  minor: {
    status: 200,
    frames: [
      {
        schema: {
          refId: 'minor',
          fields: [
            { name: 'Time', type: 'time' },
            { name: 'Value', type: 'number' },
          ],
        },
        data: {
          values: [[1779351105422], [3]],
        },
      },
    ],
  },
};

const grafanaDataFrameResponse = {
  results: {
    major: postgresVersionFrames.major,
    minor: postgresVersionFrames.minor,
  },
};

describe('getValues', () => {
  it('uses the refId to select values from a Grafana response', () => {
    assert.equal(
      getValues(grafanaDataFrameResponse, 'major'),
      postgresVersionFrames.major.frames[0]?.data.values,
    );
    assert.equal(
      getValues(grafanaDataFrameResponse, 'minor'),
      postgresVersionFrames.minor.frames[0]?.data.values,
    );
  });

  it('returns null when the refId is missing', () => {
    assert.equal(getValues({ results: {} }, 'missing'), null);
  });
});

describe('getLabels', () => {
  it('reads the label set off the first field that carries labels', () => {
    const response = {
      results: {
        instance: {
          frames: [
            {
              schema: {
                refId: 'instance',
                fields: [
                  { name: 'Time', type: 'time' },
                  {
                    name: 'Value',
                    type: 'number',
                    labels: { region: 'eu-central-1', ordinal: '0' },
                  },
                ],
              },
              data: { values: [[1779351105410], [180004]] },
            },
          ],
        },
      },
    };

    assert.deepEqual(getLabels(response, 'instance'), {
      region: 'eu-central-1',
      ordinal: '0',
    });
  });

  it('returns null when no field carries labels', () => {
    const response = {
      results: {
        instance: {
          frames: [
            {
              schema: { refId: 'instance', fields: [{ name: 'Time' }] },
              data: { values: [[1]] },
            },
          ],
        },
      },
    };

    assert.equal(getLabels(response, 'instance'), null);
    assert.equal(getLabels({ results: {} }, 'instance'), null);
  });
});

describe('promLabelValue', () => {
  it('escapes backslashes and double quotes', () => {
    assert.equal(promLabelValue('plain'), 'plain');
    assert.equal(promLabelValue('a"b'), 'a\\"b');
    assert.equal(promLabelValue('a\\b'), 'a\\\\b');
    // Escaping order matters: a quote must not end up singly-escaped by a
    // later backslash pass.
    assert.equal(promLabelValue('a\\"b'), 'a\\\\\\"b');
  });
});

describe('listGrafanaDatasources', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('GETs the datasource list', async () => {
    const datasources = [
      {
        uid: 'P06D2DA4239B6BF57',
        name: 'Prometheus (eu-central-1)',
        type: 'prometheus',
      },
    ];
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse(datasources),
    );

    assert.deepEqual(await listGrafanaDatasources(config), datasources);

    const call = fetchMock.mock.calls[0];
    assert.ok(call);
    const [url, init] = call.arguments as [string, RequestInit];
    assert.equal(url, 'https://grafana.example.com/api/datasources');
    assert.equal(init.method, 'GET');
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Bearer token',
    );
  });

  it('reports the failing operation in the error message', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ message: 'Permission denied' }, 403),
    );

    await assert.rejects(
      listGrafanaDatasources(config),
      /Grafana datasource listing failed \(403\): Permission denied/,
    );
  });
});

describe('queryGrafanaDatasource', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('posts JSON to Grafana with the service account token and returns parsed JSON', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse(grafanaDataFrameResponse),
    );

    const result = await queryGrafanaDatasource(config, { queries: [] });

    const call = fetchMock.mock.calls[0];
    assert.ok(call);
    const [url, init] = call.arguments as [string, RequestInit];
    assert.equal(url, 'https://grafana.example.com/api/ds/query');
    assert.equal(init.method, 'POST');
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Bearer token',
    );
    assert.equal(init.body, JSON.stringify({ queries: [] }));
    assert.deepEqual(result, grafanaDataFrameResponse);
  });

  it('throws a useful error when Grafana returns non-JSON', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('<!doctype html><html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );

    await assert.rejects(
      queryGrafanaDatasource(config, { queries: [] }),
      /Grafana returned non-JSON response \(200, text\/html; charset=utf-8\): <!doctype html>/,
    );
  });

  it('throws Grafana JSON error messages for failed requests', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ message: 'Data source not found' }, 404),
    );

    await assert.rejects(
      queryGrafanaDatasource(config, { queries: [] }),
      /Grafana query failed \(404\): Data source not found/,
    );
  });
});

describe('queryGrafanaPostgresQueries', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('builds a Postgres datasource payload with one query', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ results: {} }),
    );

    await queryGrafanaPostgresQueries(config, {
      datasourceUid: 'postgres-uid',
      queries: [{ refId: 'timescaledb', sql: 'SELECT 1' }],
    });

    const call = fetchMock.mock.calls[0];
    assert.ok(call);
    const [, init] = call.arguments as [string, RequestInit];
    const payload = JSON.parse(String(init.body));

    assert.equal(payload.from, 'now-1h');
    assert.equal(payload.to, 'now');
    assert.deepEqual(payload.queries[0], {
      refId: 'timescaledb',
      datasource: {
        type: 'postgres',
        uid: 'postgres-uid',
      },
      datasourceUid: 'postgres-uid',
      format: 'table',
      rawSql: 'SELECT 1',
    });
  });
});

describe('queryGrafanaPrometheusQueries', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('builds a Prometheus datasource payload with multiple queries', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      jsonResponse({ results: {} }),
    );

    await queryGrafanaPrometheusQueries(config, {
      datasourceUid: 'prometheus-uid',
      queries: [
        { refId: 'major', expr: 'version / 10000' },
        { refId: 'minor', expr: 'version % 10000' },
      ],
    });

    const call = fetchMock.mock.calls[0];
    assert.ok(call);
    const [, init] = call.arguments as [string, RequestInit];
    const payload = JSON.parse(String(init.body));

    assert.equal(payload.from, 'now-5m');
    assert.equal(payload.to, 'now');
    assert.deepEqual(payload.queries, [
      {
        refId: 'major',
        datasource: {
          type: 'prometheus',
          uid: 'prometheus-uid',
        },
        expr: 'version / 10000',
        instant: true,
        range: false,
      },
      {
        refId: 'minor',
        datasource: {
          type: 'prometheus',
          uid: 'prometheus-uid',
        },
        expr: 'version % 10000',
        instant: true,
        range: false,
      },
    ]);
  });
});
