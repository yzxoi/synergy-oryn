#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "This provisioning script is only for disposable GitHub-hosted Linux test VMs." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
sudo apt-get update
sudo apt-get install -y bubblewrap

# The AppArmor profile grants bwrap namespace setup while stripping
# capabilities from its children; do not disable the host-wide restriction.
# https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
  [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]]; then
  sudo apt-get install -y apparmor
  if [[ ! -f /etc/apparmor.d/bwrap-userns-restrict ]]; then
    profile_file=$(mktemp)
    trap 'rm -f "$profile_file"' EXIT
    curl --fail --show-error --location --retry 3 \
      'https://gitlab.com/api/v4/projects/apparmor%2Fapparmor/repository/files/profiles%2Fapparmor%2Fprofiles%2Fextras%2Fbwrap-userns-restrict/raw?ref=b4dfdf50f50ed1d64161424d036a2453645f0cfe' \
      --output "$profile_file"
    printf '%s  %s\n' 'a964037f6cf0df1099f14226b037eaedde6237c86e715188e93eb460b30be859' "$profile_file" | sha256sum --check
    sudo install -m 0644 "$profile_file" /etc/apparmor.d/bwrap-userns-restrict
  fi
  sudo apparmor_parser --replace /etc/apparmor.d/bwrap-userns-restrict
fi

/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / -- /bin/true
cargo build --locked --release --manifest-path packages/synergy/src/sandbox/helper-linux/Cargo.toml
mkdir -p "$HOME/.synergy/sandbox-helper"
cp packages/synergy/src/sandbox/helper-linux/target/release/synergy-sandbox-linux "$HOME/.synergy/sandbox-helper/"
