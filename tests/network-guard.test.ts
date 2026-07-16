import { describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  decideDestinationCategory,
  embeddedNetworkGuardSource,
  evaluateUrlDestination
} from "../src/shared/networkGuard";

const lookupFixed = (address: string) => async () => [{ address }];

describe("network guard classification", () => {
  it("classifies loopback, link-local, private, and public addresses", () => {
    expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("::1")).toBe("loopback");
    expect(classifyIpAddress("169.254.169.254")).toBe("link-local");
    expect(classifyIpAddress("fe80::1")).toBe("link-local");
    expect(classifyIpAddress("10.0.0.5")).toBe("private");
    expect(classifyIpAddress("172.16.4.4")).toBe("private");
    expect(classifyIpAddress("172.32.4.4")).toBe("public");
    expect(classifyIpAddress("192.168.1.1")).toBe("private");
    expect(classifyIpAddress("100.64.0.1")).toBe("private");
    expect(classifyIpAddress("fd00:ec2::254")).toBe("private");
    expect(classifyIpAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("93.184.216.34")).toBe("public");
  });

  it("hard-blocks metadata and private, allows loopback and public", () => {
    expect(decideDestinationCategory("link-local", "h").allowed).toBe(false);
    expect(decideDestinationCategory("private", "h").allowed).toBe(false);
    expect(decideDestinationCategory("loopback", "h").allowed).toBe(true);
    expect(decideDestinationCategory("public", "h").allowed).toBe(true);
  });
});

describe("network guard URL evaluation", () => {
  it("rejects non-http(s) protocols", async () => {
    const decision = await evaluateUrlDestination("file:///etc/passwd", lookupFixed("93.184.216.34"));
    expect(decision.allowed).toBe(false);
  });

  it("blocks a public hostname that resolves into private space (rebinding)", async () => {
    const decision = await evaluateUrlDestination("https://sneaky.example.com/x", async () => [
      { address: "93.184.216.34" },
      { address: "169.254.169.254" }
    ]);
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe("link-local");
  });

  it("allows a genuinely public host", async () => {
    const decision = await evaluateUrlDestination("https://example.com", lookupFixed("93.184.216.34"));
    expect(decision.allowed).toBe(true);
  });

  it("allows loopback for dev-server troubleshooting", async () => {
    const decision = await evaluateUrlDestination("http://localhost:3000", lookupFixed("127.0.0.1"));
    expect(decision.allowed).toBe(true);
  });
});

describe("embedded guard source", () => {
  it("emits syntactically valid JS with no backticks that would break the host template", () => {
    const source = embeddedNetworkGuardSource();
    expect(source).not.toContain("`");
    // Wrap with a stub `lookup` and confirm it parses/evaluates as a module body.
    const factory = new Function("lookup", `${source}\nreturn { classifyIpAddress, evaluateUrlDestination, guardedFetchText };`);
    const exported = factory(async () => [{ address: "127.0.0.1" }]);
    expect(exported.classifyIpAddress("169.254.169.254")).toBe("link-local");
  });
});
