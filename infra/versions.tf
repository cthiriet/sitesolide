terraform {
  required_version = ">= 1.6"

  # The state stays outside the repository: bin/terraform.sh passes its path at
  # init, ~/.config/sitesolide/terraform/terraform.tfstate by default. It
  # carries the machine's address, and has no business in a public tree.
  backend "local" {}

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_token
}
