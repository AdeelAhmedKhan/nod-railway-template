# Nod on Railway

Railway template for [Nod](https://github.com/n8n-io/nod) (pinned release in
`NOD_VERSION`, currently 0.9.0), the personal agent from n8n Labs. Nod has its
own Linux workspace and its own Chromium browser, and asks before it sends
anything or acts for you.

The deployer guide is [TEMPLATE_OVERVIEW.md](TEMPLATE_OVERVIEW.md). The
template definition, with a build sheet explaining every choice, is
[template.json](template.json).

## How it works

Upstream, the Nod server drives its workspace and browser containers only
through `docker exec`, behind a restricted Docker proxy
(`deployment/self-host/docker-proxy.mjs` in the upstream repo). Railway
services have no Docker socket, so this template keeps the same four-service
shape and replaces the transport:

- **`relay/docker`** replaces the docker CLI inside the server image. It
  accepts exactly the two exec shapes the server issues, and forwards them
  over Railway's private network. Anything else exits 125.
- **`relay/nod-relay-agent.mjs`** runs as root in the Workspace and Browser
  services. It checks a shared token (constant-time compare), applies the
  same allow rules as upstream's proxy — browser runs the bridge only, as
  `node`; workspace commands run as `node` in a per-thread directory or
  `/var/tmp`; connected-CLI users run in `/var/tmp` only — then drops
  privileges with `setpriv` (supplementary groups cleared, no-new-privs,
  empty capability bounding set) into a fixed, scrubbed environment, and
  streams stdio and the exit code back.
- **`images/`** wraps upstream's own Dockerfiles. `.github/workflows/images.yml`
  checks out upstream at the pinned tag, runs the relay tests, builds the
  upstream bases, layers the relay on top, and pushes
  `ghcr.io/adeelahmedkhan/nod-railway-{server,workspace,browser}`.

```
            public HTTPS
                 │
          ┌──────▼──────┐        private         ┌────────────┐
          │  Nod server │ ────── relay ────────► │ Workspace  │  /workspace volume
          │  (only      │ ────── relay ────────► │ Browser    │  /data volume
          │   public)   │ ────── DATABASE_URL ─► │ Postgres   │
          └─────────────┘                        └────────────┘
           /var/lib/nod volume
```

Persistence: server data on `/var/lib/nod`; workspace files on `/workspace`;
tools the agent installs persist too, because `/home/node` is a symlink into
the same volume (`/workspace/.nod-home`) — a Railway service gets one volume,
upstream expects two; browser sign-ins persist on `/data`; Postgres on its
own volume.

## What is different from upstream self-host

One thing, and it matters: upstream isolates the workspace behind an
iptables egress firewall (a separate container with `NET_ADMIN`). Railway
does not grant `NET_ADMIN`, so **the workspace firewall does not exist here**
and workspace commands can reach the project's private network. Every other
service in the template is token- or password-protected, and the template is
meant to be deployed as a dedicated project. The overview repeats this;
please read it before deploying.

Also note: there is no Railway healthcheck on the server, on purpose. Nod
returns 403 for any Host other than its configured public URL and its
`/api/health` needs the bearer token, so Railway's prober can never pass.
Restart-on-failure covers boot ordering instead.

## Tests

- `node --test test/relay.test.mjs` — the relay contract, no containers
  needed: stdio byte-for-byte, exit codes, stderr separation, workdir
  creation, token rejection, workdir/user allow rules, env scrubbing,
  privilege-drop checks, shim exit behaviour.
- `test/compose.yaml` — the four-service Railway topology under local
  Docker Compose, with no Docker socket (needs the images built first).
- A live deploy test on Railway is the final proof and is a separate,
  human-approved step; local results are not a substitute for it.

## Upgrading Nod

1. Bump `NOD_VERSION` to the new upstream tag (e.g. `nod-v0.10.0`).
2. Run `node --test test/relay.test.mjs`. If upstream changed its exec
   shapes, the tests and the relay's allow rules are updated first.
3. Push to `main` and let the images workflow build and push the new tags.
4. Update the three image tags in `template.json` and republish the
   template.

## License

Apache-2.0, same as upstream Nod. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). This is a community template; it is not made, endorsed or
supported by n8n.
