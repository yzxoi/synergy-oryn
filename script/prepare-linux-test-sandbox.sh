#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "This provisioning script is only for disposable GitHub-hosted Linux test VMs." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
sudo apt-get update
sudo apt-get install -y bubblewrap

# Ubuntu's packaged profile grants bwrap namespace setup while stripping
# capabilities from its children; do not disable the host-wide restriction.
# https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
  [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]]; then
  sudo apt-get install -y apparmor
  sudo apparmor_parser --replace /etc/apparmor.d/bwrap-userns-restrict
fi

/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / -- /bin/true
cargo build --locked --release --manifest-path packages/synergy/src/sandbox/helper-linux/Cargo.toml
mkdir -p "$HOME/.synergy/sandbox-helper"
cp packages/synergy/src/sandbox/helper-linux/target/release/synergy-sandbox-linux "$HOME/.synergy/sandbox-helper/"
