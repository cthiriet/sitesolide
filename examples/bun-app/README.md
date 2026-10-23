# bun-app

A project with a service: a port, a start command, and static files in front of
it.

```bash
sitesolide deploy
```

`routes` is what makes this cheap. Only `/api/*` reaches Bun; `index.html` and
everything else in `public/` is served by Caddy without waking the process.

The generated unit confines the service: a dedicated account, `/srv` replaced by
an empty mount with only this project's directories bound back in, and
`network: localhost` so it cannot reach anything outside the machine. Set
`"network": "outbound"` if it has to call an API, and note that the block cuts
DNS too, so a name that fails to resolve is the symptom.

To give it a secret, declare its name, never its value:

```json
"secrets": ["API_KEY", "SESSION_SECRET"]
```

Then set the values on the server, from this folder or in the dashboard's
*Secrets* section, and deploy:

```bash
sitesolide secrets set API_KEY              # typed at a prompt that does not echo it
sitesolide secrets generate SESSION_SECRET  # drawn on the server, never shown
```

`deploy` asks for a name still missing when it runs at a terminal, and never
stops on one. systemd reads the project's store as root and hands the
variables over at start; the service reads `process.env.API_KEY` and never
sees the store itself. What anyone may read, a public URL, stays in `env`.
See [docs/secrets.md](../../docs/secrets.md).
