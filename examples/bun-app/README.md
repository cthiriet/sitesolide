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

To give it a secret, declare it:

```json
"secrets": ["bun-app.env"]
```

Then create the file and its variables in the dashboard's *Secrets* section, and
deploy again. systemd reads it as root and hands the variables over; the service
never opens the file itself.
