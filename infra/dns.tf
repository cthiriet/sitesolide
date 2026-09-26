# DNS zone of the domain served.
#
# The records point directly at the attributes of the server: if the machine is
# one day recreated with another IP, the DNS follows without intervention.
#
# Everything stays in DNS only (proxied = false): the Cloudflare proxy would
# mask the origin of errors as long as Caddy has not obtained its certificate.

data "cloudflare_zone" "main" {
  filter = {
    name = var.zone
  }
}

locals {
  records = {
    root_v4 = {
      type    = "A"
      name    = var.zone
      content = hcloud_server.web.ipv4_address
    }
    # Covers every client subdomain in one go: no record to create at each new
    # client.
    wildcard_v4 = {
      type    = "A"
      name    = "*.${var.zone}"
      content = hcloud_server.web.ipv4_address
    }
    root_v6 = {
      type    = "AAAA"
      name    = var.zone
      content = hcloud_server.web.ipv6_address
    }
    wildcard_v6 = {
      type    = "AAAA"
      name    = "*.${var.zone}"
      content = hcloud_server.web.ipv6_address
    }
  }
}

resource "cloudflare_dns_record" "web" {
  for_each = local.records

  zone_id = data.cloudflare_zone.main.zone_id
  type    = each.value.type
  name    = each.value.name
  content = each.value.content
  proxied = false
  ttl     = 1 # 1 means automatic at Cloudflare
  comment = "Managed by Terraform, infra/dns.tf"
}

# Protection against domain spoofing, for whoever sends mail from the zone.
#
# Both records are optional and off by default. This configuration hosts sites;
# it does not know who sends your mail, and a record written for someone else's
# provider would have mail from yours refused. Set `spf_include` and
# `dmarc_reports_email` once you know what sends under the domain.
#
# The MX and the DKIM key of your provider are not managed here: set them where
# your provider says, they are what decide the two records below.

# SPF: which servers have the right to send under this domain.
#
# **SPF is never evaluated on the address of the `From:` displayed**, but on the
# domain of the SMTP envelope, the `Return-Path`. A service that sends with its
# own envelope, Amazon SES with its default MAIL FROM for instance, is checked
# against its own SPF and never against this one: including it here changes no
# result, costs a lookup out of the ten allowed, and authorises its whole shared
# pool to write under your domain. What aligns such a service on DMARC is DKIM.
#
# `-all` rather than `~all`: a sender not listed is refused, not merely marked.
# The day a sender is added, it is added here first.
#
# The quotes are part of the value, hence the escaping: Cloudflare expects the
# content of a TXT between quotes, and flags the record otherwise. They delimit
# the string, they do not enter into the data served, and `dig` does return a
# single level of quotes.
resource "cloudflare_dns_record" "spf" {
  count   = var.spf_include == null ? 0 : 1
  zone_id = data.cloudflare_zone.main.zone_id
  type    = "TXT"
  name    = var.zone
  content = "\"v=spf1 include:${var.spf_include} -all\""
  ttl     = 1
  comment = "Managed by Terraform, infra/dns.tf"
}

# DMARC: what the recipient does with a message that fails SPF and DKIM.
#
# `p=reject` from the start: with DKIM in place and aligned, the policy protects
# a flow that works, and a softer one only leaves the domain open while teaching
# nothing a test send does not.
#
# `rua` is what makes the policy visible. Without it a rejected message is
# rejected silently, and a broken configuration is only discovered when someone
# complains. An address inside the zone it watches needs no cross authorisation.
#
# `aspf=s` demands that the envelope be exactly the domain, not a subdomain. The
# day a sender uses a custom MAIL FROM, `bounces.<domain>` for instance, strict
# alignment fails by construction: move to `aspf=r` then.
resource "cloudflare_dns_record" "dmarc" {
  count   = var.dmarc_reports_email == null ? 0 : 1
  zone_id = data.cloudflare_zone.main.zone_id
  type    = "TXT"
  name    = "_dmarc.${var.zone}"
  content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:${var.dmarc_reports_email}\""
  ttl     = 1
  comment = "Managed by Terraform, infra/dns.tf"
}

# The two records had no count before they became optional. These keep an
# existing state pointing at the same records, where Terraform would otherwise
# plan to destroy them and create them again.
moved {
  from = cloudflare_dns_record.spf
  to   = cloudflare_dns_record.spf[0]
}

moved {
  from = cloudflare_dns_record.dmarc
  to   = cloudflare_dns_record.dmarc[0]
}
