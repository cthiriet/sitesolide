variable "hcloud_token" {
  description = "API token of the Hetzner Cloud project. Never hardcoded: it is read from secrets.auto.tfvars, ignored by git."
  type        = string
  sensitive   = true
}

variable "cloudflare_token" {
  description = "Cloudflare API token, Zone:Read and DNS:Edit permissions on the zone of the domain alone. Distinct from the one set on the server for Caddy."
  type        = string
  sensitive   = true
}

variable "zone" {
  description = "Main domain, also serving as the base for the subdomains of the projects. No default: a ready-made domain here would target somebody else's zone."
  type        = string
}

variable "dmarc_reports_email" {
  description = "Address receiving the aggregate DMARC reports, one compressed XML per day and per provider. A mailbox that is actually read, otherwise the policy stays blind. Null publishes no DMARC record."
  type        = string
  default     = null
}

variable "spf_include" {
  description = "The SPF include of whatever sends mail for the zone, for instance _spf.google.com. Null publishes no SPF record: this configuration does not know who sends your mail."
  type        = string
  default     = null
}

variable "server_name" {
  description = "Name of the machine in the Hetzner console."
  type        = string
  default     = "sitesolide"
}

variable "server_type" {
  description = "Hetzner range. cx33: 4 vCPU, 8 GB, 80 GB SSD."
  type        = string
  default     = "cx33"
}

variable "location" {
  description = "fsn1 Falkenstein, nbg1 Nuremberg, hel1 Helsinki. Stay in Europe for latency and for the data."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "System image of the server."
  type        = string
  default     = "debian-13"
}

variable "ssh_key_name" {
  description = "Name of the SSH key already registered in the Hetzner project."
  type        = string
}

variable "user" {
  description = "Non-root account created at the first boot, with sudo and the SSH key. It owns the files served: it is the account that `sitesolide init` declares in its server."
  type        = string
}

variable "backups" {
  description = "Automatic Hetzner backups (about 20 % of the price of the machine)."
  type        = bool
  default     = true
}

variable "ssh_allowed_from" {
  description = "Ranges allowed to reach port 22. Restrict to your own IP once you have a fixed IP."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
