# static-site

The smallest thing sitesolide deploys: a directory of files.

```bash
sitesolide deploy
```

It answers at `https://static-site.<your-zone>`. No systemd unit, no Caddy
block, no memory used: the wildcard block resolves the subdomain to
`/srv/sites/static-site/public` by naming convention.

Add a `build` key to the manifest if your files are generated, a static site
generator, a Tailwind compilation, and the command runs on your workstation
before anything is sent.
