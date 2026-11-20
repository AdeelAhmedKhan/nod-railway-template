# Deploy and Host Nod on Railway

Nod is an open-source personal agent from n8n Labs. It has its own Linux
workspace and its own Chromium browser. It can chase unpaid invoices, write
call briefs from your email and calendar, watch a pricing page and tell you
when it changes, cancel trials, and file paperwork. It asks before it sends
anything or acts for you. It remembers what you tell it, and you can see and
edit every note.

## About Hosting Nod

Nod's own self-host setup uses Docker Compose: the server controls its
workspace and browser containers through the host's Docker socket. Railway
has no Docker socket, so this template runs upstream's own images as
separate Railway services and connects them with a small, token-checked
exec relay on the private network:

- **Nod**: the server and web app, the only service with a public URL
- **Workspace**: the Linux machine where the agent runs commands (Python,
  Node, LibreOffice, ffmpeg, OCR, yt-dlp). Files and installed tools persist
  across restarts and redeploys.
- **Browser**: Chromium under a virtual display. Sites the agent signs in
  to stay signed in.
- **Postgres**: conversations, tasks, memory and the encrypted Vault

The images are built from Nod's own Dockerfiles at a pinned release
(0.9.0), so a redeploy never pulls a surprise upgrade. Access, Vault and
relay secrets are generated for you at deploy time; nothing secret ships in
the template.

**Sizing, honestly**: upstream's starting point for this stack is 2 CPU
cores, 8 GB RAM and 50 GB disk across the services (server ~2 GB, browser
~3 GB, workspace ~2 GB). On Railway that is a Hobby plan or above and a
real monthly cost, not a $5 toy. If you only want to try Nod, the desktop
app on your own machine is the cheaper route; this template is for an
always-on Nod that keeps working while your laptop is closed.

## First login (a few minutes after deploy)

1. Wait until all four services are green.
2. Open the **Nod** service, go to **Variables**, and copy `NOD_AUTH_TOKEN`.
3. Open the Nod service's public URL and paste the token into the access
   form.
4. Follow onboarding and connect a model. A small model such as Claude
   Haiku or a GPT mini is plenty for most errands. Nod shows estimated
   model costs under Usage.

`NOD_PUBLIC_URL` is pre-wired to your Railway domain, so the first login
works without editing variables. One Nod server belongs to one person.
Anyone holding `NOD_AUTH_TOKEN` has full access to your assistant and your
connected accounts, so treat it like a password.

## Connect the desktop app

In the Nod desktop app, choose **Connect to a server**, enter your Railway
URL and `NOD_AUTH_TOKEN`. The app then uses this server's conversations,
files, models and accounts.

## Apps, Telegram and WhatsApp

Open **Apps** to connect Gmail, Slack, Notion, Linear and others. Sign-in
goes through n8n's Composio connection service and returns to your Railway
URL. Telegram and WhatsApp are set up under **Channels**, with no variables
needed.

One manual step to expect: if you connect a ChatGPT subscription, the
sign-in finishes on a `127.0.0.1` callback page that cannot reach this
server. Nod shows you the address to copy from that page and paste back in;
that is an upstream quirk of subscription sign-in, not a broken deploy.

## Back up the Vault seed

Saved passwords and API keys are encrypted with a key derived from
`NOD_VAULT_SEED` on the Nod service. Keep a copy of that value somewhere
safe, outside Railway. Never change it: if it changes, every saved
credential becomes unreadable, and a database backup cannot recover them
without it. You can instead set `NOD_VAULT_KEY` to your own 32-byte base64
key, which overrides the seed.

## Custom domain

Attach the domain to the **Nod** service in Railway, then set
`NOD_PUBLIC_URL` to the exact new origin (for example
`https://nod.example.com`) and redeploy the Nod service. Nod rejects
requests for any host other than this value, so the two must match exactly.

## Trade-offs of running Nod on Railway

Read these before you rely on this deploy:

- **No workspace firewall.** Upstream isolates the agent's workspace
  behind an iptables egress firewall. That needs `NET_ADMIN`, which
  Railway does not grant, so it cannot be reproduced here: commands in the
  workspace can reach this project's private network. Every service in the
  template is token- or password-protected to compensate, and you should
  keep this as a **dedicated project** — do not add unrelated services with
  weak credentials to it.
- **It is a cloud computer, not your computer.** The agent cannot see your
  local files, desktop apps, local network, or a locally running model.
  Browser sign-ins happen in the cloud Chromium and stay there, and your
  Vault lives on Railway's infrastructure. That is the price of always-on;
  if the local-first privacy model is the point for you, run the desktop
  app instead.
- **Research preview.** Nod is pre-1.0 and changes quickly. This template
  pins one release; upgrading is deliberate (see the repo README), never
  automatic.

## Common Use Cases

- A personal assistant that keeps working while your laptop is closed,
  reachable from the web app, the Nod desktop app, Telegram or WhatsApp
- Daily call briefs built from your inbox, calendar and the client's
  latest news
- Following up on unpaid invoices, unanswered client questions and
  expiring trials
- Recurring reports pulled from behind logins into a sheet
- Watching web pages and alerting you only when something changes

## Dependencies for Nod Hosting

- A model provider key or a ChatGPT subscription. Anthropic, OpenAI,
  OpenRouter, Gemini, DeepSeek, Groq, Mistral and about 30 more work, as
  do OpenAI-compatible endpoints.
- Postgres (included)

### Deployment Dependencies

- [Nod repository](https://github.com/n8n-io/nod)
- [Nod documentation](https://nod.n8n.io/docs/)
- [Host your own server (upstream guide)](https://nod.n8n.io/docs/deploy/self-host/)
- [Template source, images and tests](https://github.com/AdeelAhmedKhan/nod-railway-template)
