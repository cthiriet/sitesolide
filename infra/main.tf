# Infrastructure of the served zone: a single machine serving the landing and all
# the client sites. See infra/README.md.

data "hcloud_ssh_key" "main" {
  name = var.ssh_key_name
}

# Network filtering upstream of the machine, on top of ufw set by cloud-init.
resource "hcloud_firewall" "web" {
  name = "${var.server_name}-web"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_from
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Ping serves diagnosis and external monitoring.
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "web" {
  name        = var.server_name
  image       = var.image
  server_type = var.server_type
  location    = var.location
  backups     = var.backups

  ssh_keys     = [data.hcloud_ssh_key.main.id]
  firewall_ids = [hcloud_firewall.web.id]

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    user       = var.user
    public_key = data.hcloud_ssh_key.main.public_key
  })

  labels = {
    project = "sitesolide"
    role    = "web"
  }

  lifecycle {
    # cloud-init runs only at the very first boot. Without this line, the
    # slightest touch-up of the file would destroy and recreate the machine,
    # hence every client site with it.
    ignore_changes = [user_data]
  }
}
