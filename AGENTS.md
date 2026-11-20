# Rules for this repo

- **Never commit a real secret.** No real `NOD_AUTH_TOKEN`, `NOD_VAULT_SEED`,
  `NOD_VAULT_KEY`, relay token, Postgres password, or provider API key in any
  file, including tests, examples and the compose test file. Tests use obvious
  placeholder values only. Run a secret scan before every push.
- **Pinned upstream only.** Images build from the exact upstream tag in
  `NOD_VERSION`. Never build from a floating branch or `latest` upstream, and
  never modify upstream Nod source — the server must stay pristine upstream.
  The only code of ours that touches the runtime path is `relay/` and the
  entry scripts in `images/`.
- **The relay contract is upstream's.** Allow rules in
  `relay/nod-relay-agent.mjs` implement upstream `docker-proxy.mjs`'s rules.
  If an upstream release changes the exec shapes, update the relay and its
  tests in the same change, and say what changed.
- **Tests before images.** `node --test test/relay.test.mjs` must pass before
  the images workflow runs; the workflow already enforces this.
- **No push, publish or deploy from this repo.** Pushing to GitHub, running
  the images workflow, publishing or updating the Railway template, and test
  deployments are separate, human-approved steps. Build and validate locally
  only.
- **Honesty in docs.** The template loses upstream's workspace firewall on
  Railway (no NET_ADMIN). Never write copy that hides this; the overview and
  README state it plainly, with the mitigation (dedicated project).
