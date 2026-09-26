output "ipv4" {
  description = "Public v4 IP, to be pointed at from the Cloudflare A records."
  value       = hcloud_server.web.ipv4_address
}

output "ipv6" {
  description = "Public v6 IP, for the AAAA records."
  value       = hcloud_server.web.ipv6_address
}

output "ssh_command" {
  description = "Connection command for the non-root account."
  value       = "ssh ${var.user}@${hcloud_server.web.ipv4_address}"
}

output "dns_records" {
  description = "Records to create in the Cloudflare zone."
  value = {
    "A ${var.zone}"      = hcloud_server.web.ipv4_address
    "A *.${var.zone}"    = hcloud_server.web.ipv4_address
    "AAAA ${var.zone}"   = hcloud_server.web.ipv6_address
    "AAAA *.${var.zone}" = hcloud_server.web.ipv6_address
  }
}
