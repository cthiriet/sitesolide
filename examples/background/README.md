# background

Work that runs without a visitor: a worker that runs for good, a run every
quarter of an hour, and a small page that shows what both wrote.

```bash
sitesolide deploy
```

Three services, one of each kind, each its own unit under the project's
account:

- `web` is a server. It listens on port 3041, and Caddy sends it every request
  to `https://background.<your-zone>`. It runs for good and comes first, so its
  unit keeps the project's name, `background.service`.
- `worker` is a worker: `"internal": true` and no `port`. It runs for good,
  listens on nothing and records a beat every ten seconds. systemd restarts it
  when it falls, waiting longer after each failure, up to five minutes. On
  SIGTERM, at a deployment or a restart, it finishes its beat and exits.
- `tally` is scheduled. Its timer, `background.tally.timer`, starts it at
  `*:0/15`, every quarter of an hour; it records one row and exits, and
  between two runs nothing runs. `timeout` stops a run still going after a
  minute.

The deployment does not run `tally`: the first row comes at the next quarter
of an hour. `sitesolide status` says when it last ran and when it runs next,
and `sitesolide logs` shows its runs beside the other two services.

The worker and the scheduled run yield the processor to the sites when it is
contended, as every background service does. `"cpu": "25%"` caps the worker
at a quarter of one core even when it is not.

The three share one SQLite database in the project's data folder,
`$DATA_DIR`, each through its own connection with the settings of
`database.ts`: in WAL, the page reads while the worker writes, and a writer
waits for the other rather than fail. The hourly backup copies it
consistently.

Replace the beat with the real work, a queue to consume, a connection to hold,
an API to poll, and the tally with what has to happen at set times, a report,
a sync, a cleanup. A service that calls another server needs `egress` with
the hosts it calls, or `"network": "outbound"`. Without `web`, the project
would serve no page, and its address would answer a line saying so. What
fits on the machine, and what does not:
[docs/manifest.md](../../docs/manifest.md#what-fits-on-the-machine-and-what-does-not).

On a workstation, `bun run worker.ts`, `bun run tally.ts` and `bun run web.ts`
write into `./data`, which the manifest keeps out of the upload.
