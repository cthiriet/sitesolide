#!/usr/bin/env bash
#
# sitesolide's machine as a VM on a Linux machine that already does something
# else, a box at home with services of its own that must not be at stake. Run
# on that host, as root, from a copy of this folder:
#
#   sudo infra/vm/install.sh --ssh-key <public key file> [--cpus 2] [--memory 4096]
#        [--disk 20] [--port 2222] [--hide <path>]...
#
#   --ssh-key   the public key that logs in to the guest as root, the one
#               sitesolide setup connects with
#   --cpus      the guest's processors, 2 by default
#   --memory    the guest's memory in MiB, 4096 by default; QEMU's own comes on top
#   --disk      the guest's disk in GiB, 20 by default, laid whole at once
#   --port      the host's loopback port forwarded to the guest's ssh, 2222
#   --hide      a folder of the host QEMU must never see, the data of another
#               service; as many times as there are
#
# What it lays, each part only when missing, so that it can run again:
#
#   packages     QEMU for this machine's architecture, its firmware, qemu-img,
#                cloud-localds, nftables, nc
#   account      sitesolide-vm, a system account, its home /var/lib/sitesolide-vm
#   disk         Debian 13's cloud image, its SHA-512 checked against Debian's
#                list, copied into a raw disk allocated whole: the disk never
#                grows over the host's own, and is never laid again once there
#   seed         cloud-init's first boot: the key for root, and public
#                resolvers, which the wall leaves the guest
#   wall         wall.nft and sitesolide-vm-wall.service: QEMU's account opens
#                no connection to this machine nor to its network
#   VM           sitesolide-vm.service, from this folder's template
#
# Then it starts the VM, proves the wall from QEMU's own account, and prints
# what the workstation's ssh configuration needs. Setting up sitesolide in
# the guest is the workstation's: sitesolide setup root@<that alias> --tunnel.
# See docs/tunnel.md.
#
# Nothing here touches a service of the host, its firewall or its network:
# the wall is a table of its own, judged on QEMU's account alone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE=/var/lib/sitesolide-vm
CONFIG=/etc/sitesolide-vm
LIB=/usr/local/lib/sitesolide-vm
ACCOUNT=sitesolide-vm
IMAGES=https://cloud.debian.org/images/cloud/trixie/latest

KEY=""
CPUS=2
MEMORY=4096
DISK=20
PORT=2222
HIDDEN=()

usage() {
  sed -n '7,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) KEY="${2:-}"; shift 2 ;;
    --cpus) CPUS="${2:-}"; shift 2 ;;
    --memory) MEMORY="${2:-}"; shift 2 ;;
    --disk) DISK="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --hide) HIDDEN+=("${2:-}"); shift 2 ;;
    *) usage ;;
  esac
done

die() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  exit 1
}

[ "$(id -u)" = 0 ] || die "run as root: sudo $0 ..."
[ -n "$KEY" ] || usage
[ -r "$KEY" ] || die "cannot read the public key $KEY"
grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh.com) [A-Za-z0-9+/=]+( |$)' "$KEY" ||
  die "$KEY is not a public key" "give the .pub file, never a private key"
for value in "$CPUS" "$MEMORY" "$DISK" "$PORT"; do
  [[ "$value" =~ ^[0-9]+$ ]] || die "not a number: $value"
done
[ "$MEMORY" -ge 2048 ] || die "--memory $MEMORY: sitesolide needs 2048 MiB at least"
[ "$DISK" -ge 10 ] || die "--disk $DISK: sitesolide needs 10 GiB at least"
for path in ${HIDDEN[@]+"${HIDDEN[@]}"}; do
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--hide $path: an absolute path of letters, digits, dots, dashes and slashes"
done

# --- the architecture, and what QEMU needs for it ---------------------------------
case "$(dpkg --print-architecture)" in
  arm64)
    IMAGE=debian-13-genericcloud-arm64.qcow2
    QEMU=/usr/bin/qemu-system-aarch64
    PACKAGES=(qemu-system-arm qemu-efi-aarch64)
    MACHINE="virt,accel=kvm"
    FIRMWARE="-bios /usr/share/qemu-efi-aarch64/QEMU_EFI.fd "
    ;;
  amd64)
    IMAGE=debian-13-genericcloud-amd64.qcow2
    QEMU=/usr/bin/qemu-system-x86_64
    PACKAGES=(qemu-system-x86)
    MACHINE="q35,accel=kvm"
    FIRMWARE=""
    ;;
  *) die "unsupported architecture: $(dpkg --print-architecture)" "sitesolide runs on arm64 and amd64" ;;
esac

[ -c /dev/kvm ] || die "no /dev/kvm on this machine: it cannot run a VM at a usable speed" \
  "on a Raspberry Pi, Ubuntu's kernel for it and Raspberry Pi OS's both carry KVM; check that virtualisation is not disabled"

echo "-> packages"
missing=()
for package in "${PACKAGES[@]}" qemu-utils cloud-image-utils nftables netcat-openbsd curl; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'ok installed' || missing+=("$package")
done
if [ ${#missing[@]} -gt 0 ]; then
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update -q </dev/null
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends "${missing[@]}" </dev/null
  echo "   installed: ${missing[*]}"
else
  echo "   all there"
fi

echo "-> account $ACCOUNT"
if ! id -u "$ACCOUNT" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
  echo "   made"
fi
install -d -m 0750 -o "$ACCOUNT" -g "$ACCOUNT" "$STATE"
install -d -m 0755 -o root -g root "$CONFIG" "$LIB"

echo "-> disk"
if [ -e "$STATE/disk.raw" ]; then
  echo "   $STATE/disk.raw is there: never laid again, the guest's data is in it"
else
  download=$(mktemp -d)
  trap 'rm -rf "$download"' EXIT
  curl -fsSL -o "$download/$IMAGE" "$IMAGES/$IMAGE"
  curl -fsSL -o "$download/SHA512SUMS" "$IMAGES/SHA512SUMS"
  (cd "$download" && grep " $IMAGE\$" SHA512SUMS | sha512sum -c --quiet -) || die "$IMAGE does not match Debian's SHA512SUMS: nothing was laid"
  # Allocated whole first, then the image written into it: the disk takes
  # its whole size now, never more later.
  qemu-img create -q -f raw -o preallocation=falloc "$STATE/disk.raw.new" "${DISK}G"
  qemu-img convert -n -O raw "$download/$IMAGE" "$STATE/disk.raw.new"
  chown "$ACCOUNT:$ACCOUNT" "$STATE/disk.raw.new"
  chmod 0600 "$STATE/disk.raw.new"
  mv "$STATE/disk.raw.new" "$STATE/disk.raw"
  echo "   Debian 13, ${DISK} GiB allocated"
fi

echo "-> first boot"
if [ -e "$STATE/seed.img" ]; then
  echo "   $STATE/seed.img is there: cloud-init reads it at the first boot alone"
else
  seed=$(mktemp -d)
  {
    echo "#cloud-config"
    echo "hostname: sitesolide"
    echo "disable_root: false"
    echo "ssh_pwauth: false"
    echo "ssh_authorized_keys:"
    echo "  - $(head -n 1 "$KEY")"
    # The wall refuses this machine's loopback, where QEMU forwards the
    # guest's DNS: the guest asks public resolvers instead, which answer
    # the SOA queries Caddy's DNS-01 challenge needs.
    echo "write_files:"
    echo "  - path: /etc/systemd/resolved.conf.d/20-public-resolvers.conf"
    echo "    content: |"
    echo "      [Resolve]"
    echo "      DNS=1.1.1.1 1.0.0.1"
    echo "      Domains=~."
    echo "runcmd:"
    echo "  - [systemctl, restart, systemd-resolved]"
  } >"$seed/user-data"
  printf 'instance-id: sitesolide\nlocal-hostname: sitesolide\n' >"$seed/meta-data"
  cloud-localds "$seed/seed.img" "$seed/user-data" "$seed/meta-data"
  install -m 0640 -o "$ACCOUNT" -g "$ACCOUNT" "$seed/seed.img" "$STATE/seed.img"
  rm -rf "$seed"
  echo "   root's key and public resolvers, for cloud-init"
fi

echo "-> wall"
install -m 0644 -o root -g root "$HERE/wall.nft" "$CONFIG/wall.nft"
install -m 0644 -o root -g root "$HERE/sitesolide-vm-wall.service" /etc/systemd/system/sitesolide-vm-wall.service

echo "-> VM"
install -m 0755 -o root -g root "$HERE/powerdown" "$LIB/powerdown"
hidden=""
if [ ${#HIDDEN[@]} -gt 0 ]; then
  hidden="InaccessiblePaths=$(printf -- '-%s ' "${HIDDEN[@]}")"
fi
unit=$(mktemp)
sed -e "s|@QEMU@|$QEMU|" -e "s|@MACHINE@|$MACHINE|" -e "s|@CPUS@|$CPUS|" -e "s|@MEMORY@|$MEMORY|" \
  -e "s|@FIRMWARE@|$FIRMWARE|" -e "s|@PORT@|$PORT|" -e "s|@MEMORY_MAX@|$((MEMORY + 768))|" \
  -e "s|^@HIDDEN@\$|${hidden% }|" "$HERE/sitesolide-vm.service" >"$unit"
if grep -q '@[A-Z_]*@' "$unit"; then die "a field of the template was left unfilled: nothing was laid"; fi
install -m 0644 -o root -g root "$unit" /etc/systemd/system/sitesolide-vm.service
rm -f "$unit"
systemctl daemon-reload
systemctl enable --now sitesolide-vm-wall.service >/dev/null
# Laid again under a running VM, the wall reloads in place: a restart of its
# unit would restart the VM, which requires it.
systemctl reload sitesolide-vm-wall.service
systemctl enable sitesolide-vm.service >/dev/null 2>&1
if systemctl is-active --quiet sitesolide-vm.service; then
  echo "   already running: sudo systemctl restart sitesolide-vm applies a changed unit"
else
  systemctl start sitesolide-vm.service
  # QEMU refuses a device or a disk within its first second, and systemd
  # restarts it every ten: still running five seconds on, it took them.
  sleep 5
  if ! systemctl is-active --quiet sitesolide-vm.service; then
    journalctl -u sitesolide-vm -n 5 --no-pager >&2 || true
    die "QEMU did not stay up: its own words are just above"
  fi
  echo "   started"
fi

echo "-> the wall, proven from QEMU's account"
# This machine's own ssh, on its loopback, is open to every account but
# QEMU's: reaching it would be reaching the host's other services.
if ss -Hltn 'sport = :22' | grep -q .; then
  if runuser -u "$ACCOUNT" -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' 2>/dev/null; then
    systemctl stop sitesolide-vm.service
    die "QEMU's account reached this machine's loopback: the wall does not hold, the VM is stopped" "sudo nft list table inet sitesolide_vm says what is loaded"
  fi
  echo "   127.0.0.1:22 refused to $ACCOUNT, open to the others"
else
  echo "   no ssh listening on this machine's loopback to prove it against: sudo nft list table inet sitesolide_vm"
fi

echo
echo "-> the VM runs: its console is sudo journalctl -u sitesolide-vm -f"
echo "   from the workstation, its ssh goes through this machine's. In ~/.ssh/config:"
echo
echo "   Host sitesolide-vm"
echo "     HostName 127.0.0.1"
echo "     Port $PORT"
echo "     User root"
echo "     ProxyJump <this machine, as the workstation's ssh names it>"
echo
echo "   then: ssh sitesolide-vm true, and sitesolide setup root@sitesolide-vm --zone <zone> --email <address> --tunnel <file>"
