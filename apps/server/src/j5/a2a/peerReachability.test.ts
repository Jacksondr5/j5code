import type * as NodeOS from "node:os";

import { assert, it } from "@effect/vitest";

import { peerAddressOrigins } from "./peerReachability.ts";

const interfaces: ReturnType<typeof NodeOS.networkInterfaces> = {
  lo: [
    {
      address: "127.0.0.1",
      family: "IPv4",
      internal: true,
      netmask: "255.0.0.0",
      mac: "",
      cidr: null,
    },
    {
      address: "::1",
      family: "IPv6",
      internal: true,
      netmask: "",
      mac: "",
      cidr: null,
      scopeid: 0,
    },
  ],
  eth0: [
    {
      address: "10.20.4.17",
      family: "IPv4",
      internal: false,
      netmask: "255.255.0.0",
      mac: "",
      cidr: null,
    },
    {
      address: "fe80::1",
      family: "IPv6",
      internal: false,
      netmask: "",
      mac: "",
      cidr: null,
      scopeid: 2,
    },
    {
      address: "fd7a:115c::5",
      family: "IPv6",
      internal: false,
      netmask: "",
      mac: "",
      cidr: null,
      scopeid: 0,
    },
  ],
};

it("offers each non-loopback interface address of a server bound to every interface", () => {
  assert.deepStrictEqual(peerAddressOrigins({ host: "0.0.0.0", port: 3773, interfaces }), [
    "http://10.20.4.17:3773",
    "http://[fd7a:115c::5]:3773",
  ]);
});

it("offers only the configured host of a server bound to one address", () => {
  assert.deepStrictEqual(
    peerAddressOrigins({ host: "work-vm.corp.example", port: 3773, interfaces }),
    ["http://work-vm.corp.example:3773"],
  );
});

it("offers nothing for a server that listens on loopback only", () => {
  for (const host of [undefined, "127.0.0.1", "localhost", "::1"]) {
    assert.deepStrictEqual(peerAddressOrigins({ host, port: 3773, interfaces }), [], String(host));
  }
});
