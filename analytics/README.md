# analytics

Audience measurement for the projects on the machine, on `analytics.<zone>`. A
2.5 kB script on the measured site, a SQLite database here, and **the numbers in
the dashboard**, under each site's *Audience* tab.

It answers the question every customer asks a week after launch, "is anyone
coming?", and answers it with no cookie, no consent banner, and no data
leaving the machine.

## What it does

| Path | Door | What it does |
|---|---|---|
| `POST /e` | none | receives a page view, or the time spent on the previous one |
| `GET /a.js` | none | the script placed on measured sites |

This service has no page, and cannot have one: the numbers for every site are
read together or not at all, so they are read in the dashboard. Its two paths
are exempted from the portal in `sitesolide.json`, and that is the only place it
is written: a visitor to a customer site has no portal cookie, and never will.
The portal stays in front of the rest, which is empty, and will matter the day a
page comes back here.

## Where the numbers are read

In the dashboard, under a site's *Audience* tab. The path is constrained, and
worth knowing:

```
analytics                collector (root, every minute)         dashboard
  data/instantane.json ->  copied into state.json            ->  src/audience.ts
  data/hotes.json      <-  host to served directory          <-  src/audience.ts
```

The dashboard cannot open this database, its unit replaces `/srv` with an empty
mount, nor reach this service, the loopback rule reserving ports 3000 to 3099
to Caddy and root. The collector that already reads the state of the machine is
the only existing path, and it carries the two files in the right directions:
the snapshot goes up, the allow list comes down.

## Measuring a site

One gesture: **paste the script** before `</head>`, on every page.

```html
<script defer src="https://analytics.<zone>/a.js"></script>
```

That is all: the script derives the host from the page, and the ingestion
address from its own tag. A site that moves or changes domain has nothing to
edit, beyond declaring the new host.

There is nothing to declare: the allow list of hosts is the one the collector
drops, taken from the manifests deployed on the machine and from Caddy's domain
table. A deployed site therefore becomes measurable within the minute, and a
removed site stops being so.

**A host the machine does not serve writes nothing**, silently. That is
ingestion's only door: the script is public, its format too, and without that
list any page at all could fill this database. A service started before the
collector's first pass refuses everything rather than accepting everything.

## What is measured, and what is not

What goes into the database, per page view: the host, the path without its query
string, the day, a visitor fingerprint, the referrer, the `utm_campaign` when
there is one, the browser language reduced to its primary code, a device family,
a browser, an operating system, and the time spent.

What does not go in, and will not: **the IP address**, **the user agent**, the
page's query string, and any identifier that would outlive the day.

### The fingerprint, and the salt that destroys it

Counting visitors means recognising the same browser from one page to the next.
A cookie would do it, at the price of a banner on every measured site and an
identifier following the visitor for months. Here:

```
fingerprint = HMAC-SHA256(salt of the day, host | IP address | user agent)
```

The salt is drawn at random on the day's first view, and **destroyed after two
days**. Three properties follow:

- nothing that went into the calculation is kept;
- once the salt is gone, the fingerprint attaches to nobody, and the data stops
  being personal;
- the host is part of the calculation, so the same visitor carries a different
  fingerprint on each measured site: nothing allows following them from one
  customer to another.

That is what lets measured sites do without a banner: regulators exempt audience
measurement that serves only that, cross-references nothing and identifies
nobody. The script also honours `Do Not Track` and the `Global Privacy Control`,
and does not measure visitors who set them.

### A visit is one visitor for one day

No thirty-minute session, no sliding window: the salt changes every day, so a
visit cannot straddle midnight, and slicing it more finely would produce numbers
no query could put back together.

It follows that **the same reader coming back tomorrow counts as two visits**.
That is the limit of any cookie-free measurement, and the dashboard says so in
plain words rather than implying a long-term follow.

Likewise, **time per page** is averaged only over views whose departure was
signalled: a browser killed outright sends nothing, and counting those views as
zero would drag the average down for no reason.

## What the service does not measure, and why

**The visitor's country.** It would need a ten-megabyte geolocation database
kept up to date on the machine, plus a dependency to read it, and it would
change the nature of what is kept: a country, an address and an ISP
cross-reference; a language code does not. The browser language says the
essential thing for a small site, namely whether visitors read your language.
The day a customer genuinely asks for the country, that is the one thing to add,
and it is not a light decision.

**Page titles.** They would make the list of pages more readable than a bare
path, at the price of five hundred bytes per view for a value that never changes
for a given path. On sites of a few pages, the path reads perfectly well.

**Navigation inside a single-page application.** The script measures a page
load, not a URL change without a reload. The day a site stops being pages served
by Caddy, it will need to listen to `pushState`.

**Pages displayed in an iframe.** The script stops when it is not in the top
window: a site embedded in a dashboard preview or in a third party's page is not
being read by someone who came to see it, and an iframe reloaded in a loop would
count as many visits as it has refreshes.

**What ad blockers stop.** The script is loaded from a third-party domain,
`analytics.<zone>`, which no filter list knows today. If that changed, the
counter is written down: route `/_a` to this service from the `(commun)` snippet
of the Caddyfile, which would make ingestion an address on the measured site
itself. That is a change touching every site on the machine at once, and it has
no reason to happen while measurement is not being blocked.

## What holds the service up

**The rate limit.** Nothing authenticates ingestion, and nothing can: the script
runs in the visitor's browser. Sixty views per minute per fingerprint is the
only thing separating a measurement from a counter someone inflates by hand. It
bounds what one browser can write, not what a network of machines could.

**The visitor's address is the last value of `X-Forwarded-For`**, never the
first. A proxy appends to that header, it does not replace it: reading the first
value means reading what the visitor wrote, and letting them take someone else's
fingerprint. A site behind Cloudflare's proxy would be the exception, and there
is none: the zone is `proxied = false`, and a customer domain presupposes DNS
pointing at the machine to get its certificate. The symptom, if that changed,
would be many views for a single visit; the fix would not be to trust
`CF-Connecting-IP`, which is forged in one line of `curl`.

**An empty user agent is treated as a bot.** Every browser sends one: its
absence signals a client that is not one, and the empty string would enter the
fingerprint like any other, collapsing into a single visitor everything
presenting that way from one address.

**Every refusal answers 204**, like a success. The browser does not read that
answer, `sendBeacon` does not hand it back to the script: nobody has anything to
learn from an error code, except someone trying to guess the list of accepted
hosts one host at a time.

## The database

Two tables, in `data/analytics.db`, opened by `openDatabase` with the
repository's settings.

| Table | What it holds |
|---|---|
| `sels` | one salt per day, destroyed after two days |
| `vues` | one row per page view |

The allow list is not in it: it lives in `data/hotes.json`, which the collector
rewrites every minute.

No aggregate table: a small site counts its visits in thousands per month, and
SQLite groups a million rows faster than it would take code to keep correct
counters.

Retention is four hundred days, enough to compare a month to the same month last
year, with a ceiling of five million rows to protect the disk, which is shared
with every other site on the machine. The purge runs in the service, hourly, and
it is what destroys the salts.

## Developing

```bash
bun install
bun run dev      # serves on port 3029
bun test         # the tests
bun run check    # the tests, then type checking
```

`mkdir -p data` is enough for a first run: the service does not create its own
data directory. In production `sitesolide deploy` puts it there, and the systemd
unit grants write access to it alone. Without `data/hotes.json` nothing is
accepted; to measure locally, write `{"hosts":{"localhost":"test"}}` into it,
`localhost` being discarded by the script itself anyway.

## Deploying

```bash
cd analytics
sitesolide deploy
```

No secret to place beforehand: nothing authenticates ingestion, and the
dashboard is guarded by the portal. It is the only service in the repository in
that position.
