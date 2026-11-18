// Egress firewall for WSL sandboxes.
//
// The vz and bwrap guests are NIC-less by construction, but every WSL2 distro
// shares one utility VM, one network namespace, and one IP — verified live:
// two distros report the same /proc/self/ns/net inode. That shape rules out
// the obvious host-side design: Hyper-V firewall rules target a VMCreatorId,
// which is all of WSL at once (there is no per-distribution targeting), so a
// creator-wide outbound block would also cut off the user's own distros and
// Docker Desktop. The only enforcement point that can distinguish this
// sandbox's traffic from its neighbours' is the shared guest kernel itself:
// nftables rules that match a marker carried by the sandbox's own processes.
//
// The marker is a cgroup v1 net_cls classid, not the cgroup2 socket match:
// Microsoft's WSL kernel ships without CONFIG_NFT_SOCKET (`socket cgroupv2`
// rules fail to load, observed live), but with CONFIG_CGROUP_NET_CLASSID=y.
// The boot script (root, before privileges drop) mounts net_cls, gives this
// sandbox's group a classid derived from its reserved server port — unique
// among concurrently running sandboxes by construction — and moves itself in,
// so the server and every tool it spawns inherit the marker. Egress policy:
// loopback always (the codev server and the broker stub live on 127.0.0.1),
// the host-side broker endpoint when one is configured, reject everything
// else. Reject rather than drop so a blocked connect fails immediately,
// matching the NIC-less backends' behavior instead of hanging until timeout.
//
// Fail closed: every step ends the boot on failure, so a guest image without
// nftables, or a kernel without these matches, refuses to start the sandbox
// instead of starting it unfirewalled.
//
// The reject verdict is the one piece of the ruleset that lives in a loadable
// module (CONFIG_NFT_REJECT=m; accept/drop are nf_tables core). When WSL
// services itself while its utility VM keeps running, the old package's
// modules disappear from under the live kernel and loading nft_reject_inet
// fails with ENOENT — observed live 2026-08-25 as `Could not process rule: No
// such file or directory` on exactly the reject rule while both accept rules
// loaded. That state persists until `wsl --shutdown`, so instead of refusing
// to boot the script retries the ruleset with drop: confinement is identical,
// blocked connects merely hang until timeout instead of failing fast.
//
// Residual exposure, accepted and deliberate: the VM's loopback interface is
// shared by every distro, and the blanket loopback allow means the sandbox
// can reach 127.0.0.1 services owned by neighbour distros. It cannot be
// closed by port rules without breaking the agent's own localhost workflows
// (dev servers it starts and then dials), and the output hook cannot see the
// receiving socket's owner. vz/bwrap guests do not share their loopback, so
// this is WSL-only.

// nft identifiers share the distro name, which is already restricted to
// [A-Za-z0-9._-]; nft identifiers cannot carry dots or dashes.
export function wslFirewallName(distro: string) {
  return distro.replace(/[^A-Za-z0-9_]/g, "_")
}

// "CO" in the classid's upper half namespaces codev sandboxes; the lower half
// is the sandbox's host-reserved server port, unique per running sandbox.
export function wslFirewallClassid(serverPort: number) {
  return (0x434f << 16) + serverPort
}

// Shell lines for the boot script. `hostIpVar` names the shell variable that
// holds the broker host address at runtime (never interpolated here — the
// script computes it after the guest network is up). The script reaches the
// guest over stdin, so quoted spaces are safe.
export function wslFirewallScript(options: {
  distro: string
  serverPort: number
  brokerPort: number | null
  hostIpVar?: string
}) {
  const table = wslFirewallName(options.distro)
  const classid = wslFirewallClassid(options.serverPort)
  const cgroup = `/sys/fs/cgroup/net_cls/${options.distro}`
  const hostIp = `$${options.hostIpVar ?? "HOST_IP"}`
  // Declare-empty + delete + declare-full is nft's idempotent-reset idiom:
  // one transaction, no error when the table does not exist yet, and a
  // leftover table from a previous run of this sandbox is replaced whole.
  // A failed transaction is atomic too, so the drop retry below starts clean.
  const ruleset = (verdict: "reject" | "drop") => [
    `table inet ${table} {}`,
    `delete table inet ${table}`,
    `table inet ${table} {`,
    `  chain egress {`,
    `    type filter hook output priority 0; policy accept;`,
    `    meta cgroup ${classid} oifname "lo" accept`,
    ...(options.brokerPort !== null
      ? [`    meta cgroup ${classid} ip daddr ${hostIp} tcp dport ${options.brokerPort} accept`]
      : []),
    `    meta cgroup ${classid} ${verdict}`,
    `  }`,
    `}`,
  ]
  return [
    `command -v nft >/dev/null 2>&1 || { echo "codev sandbox: nft is missing from the guest image" >&2; exit 1; }`,
    // The mount is per-distro (each distro has its own mount namespace); the
    // classid and the rules live in the shared kernel, scoped by the marker.
    `mkdir -p /sys/fs/cgroup/net_cls || exit 1`,
    `mountpoint -q /sys/fs/cgroup/net_cls || mount -t cgroup -o net_cls net_cls /sys/fs/cgroup/net_cls || exit 1`,
    `mkdir -p ${cgroup} || exit 1`,
    `echo ${classid} > ${cgroup}/net_cls.classid || exit 1`,
    `CODEV_FW_OK=1`,
    `nft -f - <<CODEV_NFT || CODEV_FW_OK=`,
    ...ruleset("reject"),
    `CODEV_NFT`,
    // Stale kernel modules (see header) fail only the reject rule; keep the
    // sandbox bootable behind an equivalent drop rule until WSL restarts.
    `[ -n "$CODEV_FW_OK" ] || {`,
    `  echo "codev sandbox: the kernel could not load the nftables reject module (a WSL update while its VM was running does this); blocked connections will hang instead of failing fast until 'wsl --shutdown'" >&2`,
    `  nft -f - <<CODEV_NFT || { echo "codev sandbox: the kernel refused the egress firewall rules; run 'wsl --shutdown' and retry" >&2; exit 1; }`,
    ...ruleset("drop"),
    `CODEV_NFT`,
    `}`,
    `echo $$ > ${cgroup}/cgroup.procs || exit 1`,
  ]
}
