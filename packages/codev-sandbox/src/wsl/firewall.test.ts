import { expect, test } from "bun:test"
import { wslFirewallClassid, wslFirewallName, wslFirewallScript } from "./firewall"

test("wslFirewallName strips characters nft identifiers cannot carry", () => {
  expect(wslFirewallName("codev-my.project_1")).toBe("codev_my_project_1")
})

test("wslFirewallClassid namespaces the server port", () => {
  expect(wslFirewallClassid(54791)).toBe(0x434f0000 + 54791)
  // Distinct ports (one per running sandbox) never collide.
  expect(wslFirewallClassid(1)).not.toBe(wslFirewallClassid(2))
})

test("firewall script fails closed at every step", () => {
  const script = wslFirewallScript({ distro: "codev-e2e", serverPort: 50000, brokerPort: null }).join("\n")
  expect(script).toContain(`command -v nft >/dev/null 2>&1 || { echo "codev sandbox: nft is missing`)
  expect(script).toContain("mount -t cgroup -o net_cls net_cls /sys/fs/cgroup/net_cls || exit 1")
  expect(script).toContain("/sys/fs/cgroup/net_cls/codev-e2e/net_cls.classid || exit 1")
  expect(script).toContain("nft -f - <<CODEV_NFT || CODEV_FW_OK=")
  expect(script).toContain(`nft -f - <<CODEV_NFT || { echo "codev sandbox: the kernel refused`)
  expect(script).toContain("echo $$ > /sys/fs/cgroup/net_cls/codev-e2e/cgroup.procs || exit 1")
})

test("a kernel that cannot load the reject module degrades to drop, not to open", () => {
  const classid = wslFirewallClassid(50000)
  const lines = wslFirewallScript({ distro: "codev-e2e", serverPort: 50000, brokerPort: 8790 })
  const script = lines.join("\n")
  expect(script).toContain(`meta cgroup ${classid} reject`)
  expect(script).toContain(`meta cgroup ${classid} drop`)
  // The fallback ruleset keeps the same holes as the primary one.
  expect(
    lines.filter((line) => line === `    meta cgroup ${classid} ip daddr $HOST_IP tcp dport 8790 accept`),
  ).toHaveLength(2)
  // Drop only runs when reject failed, and its own failure still ends the boot.
  expect(lines.indexOf(`    meta cgroup ${classid} drop`)).toBeGreaterThan(lines.indexOf(`[ -n "$CODEV_FW_OK" ] || {`))
})

test("firewall rules confine only the sandbox classid and keep loopback", () => {
  const classid = wslFirewallClassid(50000)
  const script = wslFirewallScript({ distro: "codev-e2e", serverPort: 50000, brokerPort: null }).join("\n")
  expect(script).toContain(`table inet codev_e2e {`)
  expect(script).toContain(`meta cgroup ${classid} oifname "lo" accept`)
  expect(script).toContain(`meta cgroup ${classid} reject`)
  // Without a broker there must be no hole to the host.
  expect(script).not.toContain("tcp dport")
})

test("a configured broker gets exactly one egress hole", () => {
  const classid = wslFirewallClassid(50000)
  const script = wslFirewallScript({ distro: "codev-e2e", serverPort: 50000, brokerPort: 8790 }).join("\n")
  expect(script).toContain(`meta cgroup ${classid} ip daddr $HOST_IP tcp dport 8790 accept`)
  // The reject rule still closes everything else.
  expect(script).toContain(`meta cgroup ${classid} reject`)
})

test("the reset idiom replaces a leftover table from a previous boot", () => {
  const lines = wslFirewallScript({ distro: "codev-e2e", serverPort: 50000, brokerPort: null })
  const empty = lines.indexOf("table inet codev_e2e {}")
  const del = lines.indexOf("delete table inet codev_e2e")
  const full = lines.indexOf("table inet codev_e2e {")
  expect(empty).toBeGreaterThan(-1)
  expect(del).toBe(empty + 1)
  expect(full).toBe(del + 1)
})
