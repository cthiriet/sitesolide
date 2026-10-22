# Azure DNS

`sitesolide setup --dns azure-dns` points the zone at the machine through
[Azure DNS](https://learn.microsoft.com/azure/dns/), with Azure Resource
Manager's API and nothing of Azure's to install on the workstation, and has
Caddy obtain the zone's wildcard certificate through Azure DNS as well. What
every provider shares, the records, `--dns-replace` and where credentials come
from, is in [setup.md](../setup.md#dns).

```bash
export SITESOLIDE_DNS_AZURE_TENANT_ID=<tenant ID> SITESOLIDE_DNS_AZURE_CLIENT_ID=<client ID>
export SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID=<the zone's subscription> SITESOLIDE_DNS_AZURE_RESOURCE_GROUP=<the zone's resource group>
read -rs SITESOLIDE_DNS_AZURE_CLIENT_SECRET && export SITESOLIDE_DNS_AZURE_CLIENT_SECRET   # paste the secret: nothing is echoed
sitesolide setup root@203.0.113.10 --zone <your zone> --email <you> --dns azure-dns
```

The zone has to be an Azure DNS zone already, *DNS zones*, *Create* in the
portal, and the registrar has to delegate it to the four name servers its
*Overview* page lists, `ns1-XX.azure-dns.com` to `ns4-XX.azure-dns.info`: the
setup wizard recognises a zone served by Azure DNS from them. A zone that is a
subdomain of an Azure zone, `sites.example.com` in `example.com`, needs no zone
of its own: its records go into the parent.

Azure's public cloud only: the Caddy module speaks to no sovereign cloud,
Azure China or Azure Government.

## The credentials

A service principal of its own, with the **DNS Zone Contributor** role on the
zone alone, and the zone's subscription and resource group. They stay on the
machine for as long as it serves the zone: a principal that can reach anything
else is one break-in away from it.

In the [Azure portal](https://portal.azure.com/):

1. *Microsoft Entra ID*, *App registrations*, *New registration*: a name such
   as `sitesolide-dns`, *Accounts in this organizational directory only*, no
   redirect URI. Its *Overview* shows the *Application (client) ID* and the
   *Directory (tenant) ID*.
2. In the registration, *Certificates & secrets*, *Client secrets*, *New client
   secret*, and copy its **Value**, not its *Secret ID*: the portal shows it
   once.
3. *DNS zones*, the zone, *Access control (IAM)*, *Add*, *Add role assignment*,
   the role **DNS Zone Contributor**, then *Members*, *User, group, or service
   principal*, *Select members*, the registration, and *Review + assign*.
   On the zone, never on its resource group or the subscription: the role
   given there reaches every zone they hold, and Contributor reaches
   everything.
4. The zone's *Overview* shows its *Subscription ID* and *Resource group*.

Or with the Azure CLI, which makes the registration, the secret and the role
assignment in one command:

```bash
az ad sp create-for-rbac --name sitesolide-dns --role "DNS Zone Contributor" \
  --scopes "$(az network dns zone show --resource-group <resource group> --name <your zone> --query id --output tsv)"
```

It prints `appId`, `password` and `tenant`: the client ID, the secret and the
tenant.

**Never the credentials that order machines.** sitesolide reads the DNS
credentials from variables of its own, below, and never from `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` and the others Azure's tools and `sitesolide machine
--provider azure` read: those usually hold a Contributor on a subscription, and
setup would lay them on the machine.

**Tighter still**, a custom role can take record sets only, with no right to
delete the zone, which DNS Zone Contributor has: Microsoft shows how in
[Protecting DNS zones and records](https://learn.microsoft.com/azure/dns/dns-protect-zones-recordsets#custom-roles).
It needs `Microsoft.Network/dnsZones/read`, `Microsoft.Network/dnsZones/recordsets/read`,
and `Microsoft.Network/dnsZones/A/*`, `AAAA/*`, `CNAME/*` and `TXT/*`, the last
for Caddy's challenges.

**The secret expires**: the portal suggests six months and allows two years at
most, and `az ad sp create-for-rbac` gives one year.
Caddy's renewals then fail, which the monitor's certificate check reports
fourteen days before the certificate runs out: make a new secret in the
registration, then run setup again with it, which replaces the one on the
machine.

| Variable | What it is | Shape |
|---|---|---|
| `SITESOLIDE_DNS_AZURE_TENANT_ID` | the *Directory (tenant) ID* | a UUID, or one of the tenant's domains |
| `SITESOLIDE_DNS_AZURE_CLIENT_ID` | the registration's *Application (client) ID* | a UUID |
| `SITESOLIDE_DNS_AZURE_CLIENT_SECRET` | the client secret's *Value*; secret | printable ASCII, no space, quote or backslash |
| `SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID` | the zone's subscription | a UUID |
| `SITESOLIDE_DNS_AZURE_RESOURCE_GROUP` | the zone's resource group | Azure's resource group name |

They come from the environment, from standard input with
`--dns-credentials-stdin`, one `VARIABLE=value` line each, or from the
wizard's prompts, the secret's without echo; never from an option. sitesolide
exchanges the secret at Microsoft Entra for an access token at each run, in the
Authorization header of that request, or, should Entra refuse it there, once
more in the request's form body, as Microsoft's own libraries send it; the
token goes in the Authorization header of every call to Resource Manager.
Neither is ever in an address, a message or a line printed.

## What setup creates

The zone's records, through Resource Manager's record sets, one per name and
type:

| Record set | Type | Value | TTL |
|---|---|---|---|
| `@` | A | the machine's IPv4 | 300 |
| `*` | A | the machine's IPv4 | 300 |
| `@` | AAAA | the machine's IPv6, when it has one | 300 |
| `*` | AAAA | the machine's IPv6, when it has one | 300 |

For a zone held by a parent, the sets are `sites` and `*.sites` in it.

A set that already says the right thing is left as it is, and a second run
writes nothing. A set that points elsewhere is refused with the rest of the
plan, nothing written, unless `--dns-replace`: then the one value is changed,
and only that one. The set's other values, its TTL and its metadata are kept;
a set left without a value is deleted. Each set is written back under
`If-Match` with the ETag read, so that a set somebody changes meanwhile is read
again rather than overwritten.

An **alias record set**, one that takes its address from another Azure
resource, a public IP or a Front Door, holds no value of its own and is shown
as `alias of <resource>`: it points elsewhere, and `--dns-replace` replaces it
with a plain set holding the machine's address. A CNAME at either name is
refused the same way, and deleted under `--dns-replace` before the address
takes its name. MX, TXT, CAA, NS and the zone's SOA are never touched.

## What Caddy keeps on the machine

Caddy renews the wildcard every two months through a DNS-01 challenge, a TXT
record `_acme-challenge.<zone>` it creates and deletes in the zone, with the
module [`github.com/caddy-dns/azure`](https://github.com/caddy-dns/azure)
(`dns.providers.azure`), which setup adds with `caddy add-package`.

The five variables above are in `/etc/caddy/cloudflare.env`, root:caddy 0640,
which systemd hands to Caddy: the file keeps that name whatever the provider,
the one machines in service load. `/etc/caddy/tls-zone.caddy` reads them from
Caddy's environment and holds none of them:

```caddy
tls {
	dns azure {
		tenant_id {env.SITESOLIDE_DNS_AZURE_TENANT_ID}
		client_id {env.SITESOLIDE_DNS_AZURE_CLIENT_ID}
		client_secret {env.SITESOLIDE_DNS_AZURE_CLIENT_SECRET}
		subscription_id {env.SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID}
		resource_group_name {env.SITESOLIDE_DNS_AZURE_RESOURCE_GROUP}
	}
}
```

## Tests

`SITESOLIDE_AZURE_DNS_API` points setup at another address than
`https://management.azure.com`, and `SITESOLIDE_AZURE_DNS_LOGIN` at another
than `https://login.microsoftonline.com`, for a local fake of both
(`bin/tests/fake-dns-azure-dns.ts`). Each takes https, or http on the loopback
only, so that no credential ever travels in the clear.
