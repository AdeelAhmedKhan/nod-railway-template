#!/bin/sh
# Boots the Nod server as user node after preparing what the Railway
# template cannot express directly: volume ownership, a canonical Vault
# key, and the relay config file the docker shim reads.
set -eu
: "${NOD_RELAY_TOKEN:?NOD_RELAY_TOKEN is required}"
: "${NOD_WORKSPACE_RELAY:?NOD_WORKSPACE_RELAY is required (host:port)}"
: "${NOD_BROWSER_RELAY:?NOD_BROWSER_RELAY is required (host:port)}"

data=${NOD_DATA_ROOT:-/var/lib/nod}
mkdir -p "$data/workspaces"
chown node:node "$data" "$data/workspaces"
chmod 700 "$data"

# Nod requires NOD_VAULT_KEY as canonical base64 of exactly 32 bytes
# (upstream src/providers/environment/key-store.ts). Railway's secret()
# cannot emit that shape, so the template generates a random seed and this
# script derives the key deterministically: same seed, same key, every
# boot. Setting NOD_VAULT_KEY directly overrides the seed.
if [ -z "${NOD_VAULT_KEY:-}" ]; then
  : "${NOD_VAULT_SEED:?Set NOD_VAULT_SEED or NOD_VAULT_KEY}"
  NOD_VAULT_KEY=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.NOD_VAULT_SEED).digest("base64"))')
  export NOD_VAULT_KEY
fi

# The docker shim reads its config from $DOCKER_CONFIG/nod-relay.json
# because the server passes only a scrubbed environment to its children.
mkdir -p /etc/nod-relay
umask 077
node -e 'require("fs").writeFileSync("/etc/nod-relay/nod-relay.json", JSON.stringify({token: process.env.NOD_RELAY_TOKEN, workspace: process.env.NOD_WORKSPACE_RELAY, browser: process.env.NOD_BROWSER_RELAY}))'
chown -R node:node /etc/nod-relay
umask 022
export DOCKER_CONFIG=/etc/nod-relay

# The server process itself never needs the relay token or the vault seed
# after this point; remove them from its environment.
unset NOD_RELAY_TOKEN NOD_VAULT_SEED

cd /app
exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node node --import tsx src/server/index.ts
