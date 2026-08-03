# Tiger Grafana MCP Server

MCP server that queries Timescale Grafana datasources (Postgres and Prometheus) to return information about user instances.

Built on [`@tigerdata/mcp-boilerplate`](https://www.npmjs.com/package/@tigerdata/mcp-boilerplate) and the [Model Context Protocol](https://modelcontextprotocol.io/introduction).

## Tools

| Tool | Description |
|------|-------------|
| `user_instance_basic_information` | Returns PostgreSQL and TimescaleDB versions for a given `projectId` and `serviceId`, plus a region-scoped deep link (`dashboardUrl`) to the **user-instance-single** Grafana dashboard. |
| `grafana_dashboard_link` | Returns a region-scoped deep link to any dashboard in the registry below for a given `projectId` and `serviceId`, with every template variable resolved from live metrics. |

### `grafana_dashboard_link`

Pick a dashboard with the `dashboard` parameter:

| `dashboard` | Grafana dashboard | Use it for |
|-------------|-------------------|------------|
| `user-instance` | `user-instance-single` | Generic per-service Postgres view: CPU, memory, disk, connections, query stats. |
| `pg-connector` | `postgres-livesync-single-user` | Per-service Postgres source connector: replication lag, apply/flush LSN, sync state. **The dashboard for `PgConnector*` alerts.** |
| `pooler` | `connection-pooler` | Client/server connections, pool saturation, wait times. |
| `tigerlake` | `tigerlake-performance` | Tigerlake (Iceberg destination) throughput and latency. |
| `connector-k8s-events` | `connector-k8s-events` | Kubernetes events for connector workloads: restarts, evictions, scheduling failures. |

Optional parameters: `region` (skips region resolution, for services that have stopped reporting metrics), `from` and `to` (default `now-2d` → `now`).

Rather than assuming values, the tool resolves them from the service's own metrics via Thanos and from Grafana's datasource list:

- **region**: from the `region` label on the service's metrics.
- **Prometheus datasource UID**: by looking up `Prometheus (<region>)` in `/api/datasources`. Per-region UIDs are not hardcoded, so new regions work without a code change.
- **pod**: the primary Postgres member (`<service>-an-<ordinal>`), reconstructed from the `node_name` and `ordinal` labels. Note this is the *database* pod, which is what the livesync dashboard's `pod` variable scopes its panels to, not the connector pod.
- **app_name**: the connector's `container` label, e.g. `pgsrc-connector`.

Anything that cannot be resolved is left out of the link so the dashboard applies its own default, and is reported in `omittedVariables` and `warnings` instead of being guessed.

> **`region` means different things on different dashboards.** On `user-instance` and `pooler`, the human region lives in `plain_region` while `region`/`datasource` holds a Grafana datasource UID. On `pg-connector` it is inverted: `region` is the human region and the UID lives in `prom_region`. Filling the wrong one produces a link that loads but renders another region's data. The per-dashboard mapping lives in [`src/dashboards.ts`](src/dashboards.ts).

## Requirements

- Node.js 22+
- A Grafana URL reachable from where the server runs
- A Grafana **service account token** with permission to query datasources *and* to list them (`datasources:read` on `datasources:*`), which `grafana_dashboard_link` needs to resolve per-region Prometheus UIDs

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `GRAFANA_URL` | yes | Grafana API base URL (no trailing slash). In-cluster: `http://monitoring-v2-grafana.savannah-system.svc.cluster.local` |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | yes | Grafana service account token (Bearer auth) |
| `PROD_DEPLOY` | no | When `true`, deep links target the prod Grafana host and the prod log hosts (`log.prod-<region>.ops.forge.timescale.com`). Anything else (or unset) targets dev. Used only for user-facing URLs, not for API queries. |

Create a `.env` file in the project root:

```bash
GRAFANA_URL=http://monitoring-v2-grafana.savannah-system.svc.cluster.local
GRAFANA_SERVICE_ACCOUNT_TOKEN=your-token-here
```

### Grafana service account token

1. Open Grafana (dev: `https://grafana.dev-us-east-1.ops.dev.timescale.com` or your environment URL).
2. **Administration** → **Service accounts** → create or select an account.
3. Add a token with access to the Postgres and Prometheus datasources used by the tools, plus permission to list datasources (`datasources:read`).
4. Put the token in `GRAFANA_SERVICE_ACCOUNT_TOKEN`.

For Kubernetes deploys, the token is stored as a sealed secret in [`tiger-agents-deploy`](../tiger-agents-deploy) under `charts/tiger-grafana-mcp-server/values/dev.yaml`.

## Development

```bash
git clone git@github.com:timescale/tiger-grafana-mcp-server.git
cd tiger-grafana-mcp-server
npm install
npm run build
```

### One-command local dev (recommended)

The repo ships a script that installs deps, builds, opens a `kubectl` tunnel to the in-cluster dev Grafana, starts the MCP server on HTTP, and launches the MCP Inspector pointed at it.

```bash
./scripts/dev-inspector.sh
```

Prerequisites:
- `.env` exists with `GRAFANA_SERVICE_ACCOUNT_TOKEN` set
- `kubectl` configured against the dev cluster (e.g. `kubectx ts-dev@us-east-1`)
- Node.js 22+

The script overrides `GRAFANA_URL` to the local tunnel (`http://localhost:3000`) for the duration of the run, and tears the tunnel + MCP server down on exit.

### Run manually

**HTTP** (default for Docker):

```bash
npm run build
node dist/index.js http
```

**stdio** (for Claude Desktop / Inspector):

```bash
node dist/index.js stdio
```

### Scripts

| Command | Description |
|---------|-------------|
| `./scripts/dev-inspector.sh` | One-command local dev: tunnel + MCP server + Inspector |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type check only |
| `npm run test` | Run tests |
| `npm run lint` | Biome lint |
| `npm run inspector` | Open MCP Inspector |

### MCP Inspector (manual)

```bash
npm run build
npx @modelcontextprotocol/inspector
```

| Field | Value |
|-------|-------|
| Transport | `STDIO` |
| Command | `node` |
| Arguments | `dist/index.js` |

Set `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the inspector env section (or use `.env` with stdio after loading dotenv via your shell).

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "tiger-grafana": {
      "command": "node",
      "args": ["/absolute/path/to/tiger-grafana-mcp-server/dist/index.js", "stdio"],
      "env": {
        "GRAFANA_URL": "http://monitoring-v2-grafana.savannah-system.svc.cluster.local",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Deployment

Images are built and deployed via GitHub Actions, which dispatch workflows in [tiger-agents-deploy](https://github.com/timescale/tiger-agents-deploy).

| Event | Behavior |
|-------|----------|
| Pull request, or push to `main` | Run Biome, `tsc --noEmit`, and the test suite (`check.yaml`). |
| Push to a feature branch | Build image tagged `auto-<sha>` only. No deploy, and the `latest` tag is left alone so a branch cannot roll over what `main` published. |
| Manual **Deploy Feature Branch** run | Deploy that branch's `auto-<sha>` image to **dev** (`savannah-system`). No Slack notification. |
| Push to `main` | Build image (`latest` + `auto-<sha>`), deploy to **dev**. Prod deploy is wired in the workflow but currently disabled until prod secrets/config are ready. |

This matches the other Tiger MCP servers (`tiger-slab-mcp-server`, `tiger-linear-mcp-server`, and friends): feature branches build automatically and deploy only on request, and every deploy names an immutable commit SHA rather than a moving tag.

Helm chart: `tiger-agents-deploy/charts/tiger-grafana-mcp-server`

When prod deploys are enabled, set `PROD_DEPLOY=true` in the prod chart values so the deep links resolve to `https://grafana.prod-us-east-1.ops.forge.timescale.com` instead of the dev host.

**Dev Tailscale URL** (when Tailscale is enabled in dev values):

`https://tiger-grafana-mcp-server.tail9d164.ts.net`

## License

Apache-2.0
