// Who a request is counted as: the client address behind a proxy (never the client-chosen
// leftmost X-Forwarded-For entry), IPv6 grouped per /64, and per-email caps on sign-in failures and
// emailed codes that hold no matter how many networks someone uses, without letting anyone lock a
// chosen address out of getting codes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { emailCode, password } from "../src/auth";
import { forwardedClient, networkKey } from "../src/engine/http";
import { authTables, defineSchema } from "../src/server";

describe("forwardedClient", () => {
  test("takes the entry the trusted proxy appended, not what the client wrote", () => {
    // The client sent "1.1.1.1"; one proxy appended the address it saw.
    expect(forwardedClient("1.1.1.1, 203.0.113.9")).toBe("203.0.113.9");
    expect(forwardedClient("1.1.1.1, 2.2.2.2,203.0.113.9 ", 1)).toBe("203.0.113.9");
    // Two proxies (CDN, then a load balancer): the CDN's entry is the client.
    expect(forwardedClient("1.1.1.1, 203.0.113.9, 10.0.0.5", 2)).toBe("203.0.113.9");
    // A proxy that overwrites the header leaves one entry.
    expect(forwardedClient("203.0.113.9", 2)).toBe("203.0.113.9");
    expect(forwardedClient("", 1)).toBeNull();
    expect(forwardedClient(null)).toBeNull();
    expect(forwardedClient(" , ")).toBeNull();
  });
});

describe("networkKey", () => {
  test("IPv6 counts per /64, IPv4 as is", () => {
    expect(networkKey("203.0.113.9")).toBe("203.0.113.9");
    expect(networkKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(networkKey("2001:0DB8:0001:0002:ffff:ffff:ffff:fffe")).toBe("2001:db8:1:2::/64");
    expect(networkKey("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(networkKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
    expect(networkKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(networkKey("unknown")).toBe("unknown");
    expect(networkKey("not:an:ip:::")).toBe("not:an:ip:::");
  });
});

describe("sign-in limits behind a proxy", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;
  const sent: { email: string; code: string; purpose: string }[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-net-"));
    app = await startApp({
      schema: defineSchema({ ...authTables }),
      modules: {},
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      trustProxy: true,
      auth: { methods: [password({ sendCode: (m) => void sent.push(m) }), emailCode({ sendCode: (m) => void sent.push(m) })] },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (body: unknown, xff?: string) =>
    fetch(`${base}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(xff ? { "X-Forwarded-For": xff } : {}) },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((j: any) => ({ status: r.status, body: j })));
  const signIn = (email: string, pw: string, xff?: string) => post({ provider: "password", params: { flow: "signIn", email, password: pw } }, xff);

  test("a client-chosen leftmost X-Forwarded-For doesn't give a fresh lockout count", async () => {
    expect((await post({ provider: "password", params: { flow: "signUp", email: "xff@example.com", password: "correct horse" } })).status).toBe(200);
    // The attacker rotates what they write; the proxy appends their real address each time.
    for (let i = 0; i < 10; i++) expect((await signIn("xff@example.com", "wrong guess", `10.9.${i}.1, 203.0.113.50`)).status).toBe(401);
    expect((await signIn("xff@example.com", "correct horse", `10.9.99.1, 203.0.113.50`)).status).toBe(429);
  });

  test("addresses in one IPv6 /64 share a count", async () => {
    await post({ provider: "password", params: { flow: "signUp", email: "v6@example.com", password: "correct horse" } });
    for (let i = 0; i < 10; i++) expect((await signIn("v6@example.com", "wrong guess", `2001:db8:5:6::${i + 1}`)).status).toBe(401);
    expect((await signIn("v6@example.com", "correct horse", "2001:db8:5:6:dead:beef::1")).status).toBe(429);
    // Another /64 is another network.
    expect((await signIn("v6@example.com", "correct horse", "2001:db8:5:7::1")).status).toBe(200);
  });

  test("failures for one email are capped across every network", async () => {
    await post({ provider: "password", params: { flow: "signUp", email: "many@example.com", password: "correct horse" } });
    // 100 wrong passwords from 100 networks, each well under its own limit of 10…
    for (let batch = 0; batch < 10; batch++) {
      const tries = await Promise.all(Array.from({ length: 10 }, (_, i) => signIn("many@example.com", "wrong guess", `198.18.${batch * 10 + i}.1`)));
      expect(tries.map((t) => t.status)).toEqual(Array(10).fill(401));
    }
    // …and the 101st guess is refused whatever network it comes from, even with the right password.
    expect((await signIn("many@example.com", "correct horse", "198.19.0.1")).status).toBe(429);
    // A password reset (proving the inbox) clears the count.
    expect((await post({ provider: "password", params: { flow: "reset", email: "many@example.com" } }, "198.19.0.2")).status).toBe(200);
    await Bun.sleep(20);
    const code = sent.findLast((m) => m.email === "many@example.com" && m.purpose === "reset")!.code;
    const reset = await post(
      { provider: "password", params: { flow: "reset-verification", email: "many@example.com", code, newPassword: "new password!" } },
      "198.19.0.2",
    );
    expect(reset.status).toBe(200);
    expect((await signIn("many@example.com", "new password!", "198.19.0.3")).status).toBe(200);
  }, 60_000);

  test("asking for codes for someone else's address doesn't stop them getting one", async () => {
    const start = (email: string, xff: string) => post({ provider: "email", params: { email } }, xff);
    const sentTo = (email: string) => sent.filter((m) => m.email === email).length;
    // The attacker asks six times from their network: five codes go out, then the answer stays the same but nothing is sent.
    for (let i = 0; i < 6; i++) expect(await start("target@example.com", "203.0.113.66")).toEqual({ status: 200, body: { codeSent: true } });
    expect(sentTo("target@example.com")).toBe(5);
    // A password reset for the same address from that network is also silently not sent…
    expect(await post({ provider: "password", params: { flow: "reset", email: "target@example.com" } }, "203.0.113.66")).toEqual({
      status: 200,
      body: { codeSent: true },
    });
    // …while the owner, from their own network, still gets a code and signs in with it.
    expect(await start("target@example.com", "198.51.100.20")).toEqual({ status: 200, body: { codeSent: true } });
    expect(sentTo("target@example.com")).toBe(6);
    const code = sent.findLast((m) => m.email === "target@example.com")!.code;
    const signedIn = await post({ provider: "email", params: { email: "target@example.com", flow: "verify", code } }, "198.51.100.20");
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.token).toStartWith("ob_s_");
  });

  test("codes for one address are capped across every network, silently", async () => {
    const start = (xff: string) => post({ provider: "email", params: { email: "flood@example.com" } }, xff);
    for (let i = 0; i < 25; i++) expect((await start(`192.0.2.${i + 1}`)).body).toEqual({ codeSent: true });
    expect(sent.filter((m) => m.email === "flood@example.com").length).toBe(20);
  });
});
