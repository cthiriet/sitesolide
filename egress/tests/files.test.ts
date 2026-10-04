import { describe, expect, test } from "bun:test";
import {
  EMPTY_CONNECTORS,
  EMPTY_GRANTS,
  connectorNamed,
  connectorViews,
  headerNameError,
  headerValueError,
  isGranted,
  parseConnectors,
  parseGrants,
  putConnector,
  readBaseUrl,
  removeConnector,
  serializeConnectors,
  serializeGrants,
  setGrant,
  type ConnectorsFile,
} from "../../bin/cli/connectors";

/**
 * The two files the steward writes and the proxy reads, in the module both
 * embed. The value used here is a placeholder made for the test, never a real
 * credential.
 */
const NOW = "2026-10-04T12:00:00.000Z";
const LATER = "2026-10-05T08:30:00.000Z";
const VALUE = "Bearer test-value-0123456789";

function withChat(): ConnectorsFile {
  const result = putConnector(EMPTY_CONNECTORS, { name: "chat", baseUrl: "https://chat.example.com/api", header: "Authorization", value: VALUE }, NOW, "owner");
  if ("error" in result) throw new Error(result.error);
  return result.file;
}

describe("a connector's base address", () => {
  test("https, a host name, an optional port and path, written back canonically", () => {
    expect(readBaseUrl("https://Chat.Example.com/api/")).toEqual({ url: "https://chat.example.com/api", host: "chat.example.com", port: 443, path: "/api" });
    expect(readBaseUrl("https://chat.example.com")).toEqual({ url: "https://chat.example.com", host: "chat.example.com", port: 443, path: "" });
    expect(readBaseUrl("https://chat.example.com:8443/v2")).toMatchObject({ url: "https://chat.example.com:8443/v2", port: 8443 });
  });

  test("refuses another scheme, a credential, a query, an address and a disguised path", () => {
    for (const raw of [
      "http://chat.example.com",
      "https://user:pw@chat.example.com",
      "https://chat.example.com/?token=x",
      "https://chat.example.com/#x",
      "https://10.0.0.1/api",
      "https://[::1]/api",
      "https://localhost/api",
      "https://chat.example.com/a%2fb",
      "https://chat.example.com\\api",
      " https://chat.example.com",
      "",
      42,
      `https://chat.example.com/${"a".repeat(600)}`,
    ]) {
      expect({ raw, ok: !("error" in readBaseUrl(raw)) }).toEqual({ raw, ok: false });
    }
  });
});

describe("a connector's header", () => {
  test("any header name but those that frame the request", () => {
    for (const name of ["Authorization", "X-Api-Key", "PRIVATE-TOKEN"]) expect(headerNameError(name)).toBeNull();
    for (const name of ["Host", "content-length", "Transfer-Encoding", "Connection", "Proxy-Authorization", "Bad Name", "", "X:Y"]) {
      expect(headerNameError(name)).not.toBeNull();
    }
  });

  test("a value of printable ASCII on one line, and a refusal that never quotes it", () => {
    expect(headerValueError(VALUE)).toBeNull();
    for (const value of ["", " lead-x9", "trail-x9 ", "line\r\nX-Injected: 1", "tab\there", "é", "a".repeat(8193)]) {
      const error = headerValueError(value);
      expect(error).not.toBeNull();
      if (value.length > 3) expect(error).not.toContain(value);
    }
  });
});

describe("connectors.json", () => {
  test("created, read back, and written in a fixed order", () => {
    const file = withChat();
    const text = serializeConnectors(file);
    const parsed = parseConnectors(text);
    expect(parsed).toEqual({ file });
    expect(serializeConnectors((parsed as { file: ConnectorsFile }).file)).toBe(text);
  });

  test("missing or empty is an empty list", () => {
    expect(parseConnectors("")).toEqual({ file: EMPTY_CONNECTORS });
    expect(parseConnectors("  \n")).toEqual({ file: EMPTY_CONNECTORS });
  });

  test("one entry that does not read refuses the whole file, and the error never quotes a value", () => {
    const base = JSON.parse(serializeConnectors(withChat())) as { connectors: Record<string, Record<string, unknown>> };
    const broken = (change: (record: Record<string, unknown>) => void) => {
      const copy = structuredClone(base);
      change(copy.connectors.chat!);
      return parseConnectors(JSON.stringify(copy));
    };
    for (const result of [
      broken((record) => (record.baseUrl = "http://chat.example.com")),
      broken((record) => (record.header = "Host")),
      broken((record) => (record.value = "a\nb")),
      broken((record) => (record.extra = 1)),
      broken((record) => (record.updatedAt = "yesterday")),
      parseConnectors("{"),
      parseConnectors('{"version":2,"connectors":{}}'),
      parseConnectors('{"version":1,"connectors":{"Bad":{}}}'),
    ]) {
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error).not.toContain(VALUE);
    }
  });

  test("the page's view carries everything but the value", () => {
    const views = connectorViews(withChat());
    expect(views).toEqual([
      { name: "chat", baseUrl: "https://chat.example.com/api", header: "Authorization", updatedAt: NOW, secretUpdatedAt: NOW, updatedBy: "owner" },
    ]);
    expect(JSON.stringify(views)).not.toContain(VALUE);
  });
});

describe("changing a connector", () => {
  test("a creation needs a value", () => {
    const result = putConnector(EMPTY_CONNECTORS, { name: "chat", baseUrl: "https://chat.example.com", header: "Authorization", value: null }, NOW, "owner");
    expect(result).toEqual({ error: "value: required to create a connector" });
  });

  test("a change without a value keeps it, and its date: no rotation is claimed", () => {
    const result = putConnector(withChat(), { name: "chat", baseUrl: "https://chat.example.com/v2", header: "Authorization", value: null }, LATER, "owner");
    if ("error" in result) throw new Error(result.error);
    expect(result.created).toBe(false);
    expect(result.file.connectors.chat).toMatchObject({ baseUrl: "https://chat.example.com/v2", value: VALUE, updatedAt: LATER, secretUpdatedAt: NOW });
  });

  test("a new value moves the value's date", () => {
    const result = putConnector(withChat(), { name: "chat", baseUrl: "https://chat.example.com/api", header: "Authorization", value: "Bearer rotated-0123" }, LATER, "owner");
    if ("error" in result) throw new Error(result.error);
    expect(result.file.connectors.chat).toMatchObject({ secretUpdatedAt: LATER, updatedAt: LATER });
  });

  test("refuses a bad name, address, header or value", () => {
    const input = { name: "chat", baseUrl: "https://chat.example.com", header: "Authorization", value: VALUE };
    expect(putConnector(EMPTY_CONNECTORS, { ...input, name: "Chat" }, NOW, "owner")).toHaveProperty("error");
    expect(putConnector(EMPTY_CONNECTORS, { ...input, baseUrl: "ftp://x.example.com" }, NOW, "owner")).toHaveProperty("error");
    expect(putConnector(EMPTY_CONNECTORS, { ...input, header: "Host" }, NOW, "owner")).toHaveProperty("error");
    expect(putConnector(EMPTY_CONNECTORS, { ...input, value: "two\nlines" }, NOW, "owner")).toHaveProperty("error");
  });

  test("a removal takes its grants with it", () => {
    const granted = setGrant(EMPTY_GRANTS, withChat(), "shop", "chat", true, NOW, "owner");
    if ("error" in granted) throw new Error(granted.error);
    const removed = removeConnector(withChat(), granted.file, "chat", LATER, "owner");
    if ("error" in removed) throw new Error(removed.error);
    expect(removed.connectors.connectors).toEqual({});
    expect(removed.grants.grants).toEqual([]);
    expect(removeConnector(EMPTY_CONNECTORS, EMPTY_GRANTS, "chat", LATER, "owner")).toEqual({ error: "no connector named chat" });
  });
});

describe("a name every object inherits", () => {
  const INHERITED = ["constructor", "__proto__", "toString"];

  test("refuses the whole file that holds one, and a grant of one", () => {
    const record = JSON.parse(serializeConnectors(withChat())).connectors.chat;
    for (const name of INHERITED) {
      // Written as text: `{ __proto__: ... }` in a literal would set the
      // prototype rather than a key, and prove nothing.
      const text = `{"version":1,"connectors":{${JSON.stringify(name)}:${JSON.stringify(record)}}}`;
      expect({ name, parsed: parseConnectors(text) }).toEqual({ name, parsed: { error: `connectors.json: "${name}" is not a connector name` } });
      const grant = JSON.stringify({ version: 1, grants: [{ slug: "shop", connector: name, at: NOW, by: "owner" }] });
      expect({ name, parsed: parseGrants(grant) }).toEqual({ name, parsed: { error: "grants.json: a grant is unreadable" } });
    }
  });

  test("is refused as a connector to create, change, grant or remove", () => {
    const file = withChat();
    for (const name of INHERITED) {
      // With a value, and without one: the second used to take the inherited
      // property for an existing connector, and write a record with no value.
      for (const value of [VALUE, null]) {
        const put = putConnector(file, { name, baseUrl: "https://chat.example.com", header: "Authorization", value }, LATER, "owner");
        expect({ name, value, put: "error" in put }).toEqual({ name, value, put: true });
      }
      expect(setGrant(EMPTY_GRANTS, file, "shop", name, true, NOW, "owner")).toEqual({ error: "connector: not a connector name" });
      expect(removeConnector(file, EMPTY_GRANTS, name, LATER, "owner")).toEqual({ error: `no connector named ${name}` });
      expect(connectorNamed(file, name)).toBeUndefined();
    }
    expect(putConnector(file, { name: "constructor", baseUrl: "https://chat.example.com", header: "Authorization", value: null }, LATER, "owner")).toEqual({
      error: "name: constructor is reserved, every JavaScript object already carries that name",
    });
    expect(connectorNamed(file, "chat")).toMatchObject({ value: VALUE });
  });
});

describe("grants.json", () => {
  test("granted, read back, withdrawn", () => {
    const connectors = withChat();
    const granted = setGrant(EMPTY_GRANTS, connectors, "shop", "chat", true, NOW, "owner");
    if ("error" in granted) throw new Error(granted.error);
    expect(granted.changed).toBe(true);
    expect(isGranted(granted.file, "shop", "chat")).toBe(true);
    expect(isGranted(granted.file, "blog", "chat")).toBe(false);
    expect(parseGrants(serializeGrants(granted.file))).toEqual({ file: granted.file });

    const again = setGrant(granted.file, connectors, "shop", "chat", true, LATER, "owner");
    expect(again).toEqual({ file: granted.file, changed: false });

    const withdrawn = setGrant(granted.file, connectors, "shop", "chat", false, LATER, "owner");
    if ("error" in withdrawn) throw new Error(withdrawn.error);
    expect(withdrawn.file.grants).toEqual([]);
    expect(withdrawn.file.updatedAt).toBe(LATER);
  });

  test("granting a connector that does not exist, or to what is not a site, is refused", () => {
    expect(setGrant(EMPTY_GRANTS, EMPTY_CONNECTORS, "shop", "chat", true, NOW, "owner")).toEqual({ error: "no connector named chat" });
    expect(setGrant(EMPTY_GRANTS, withChat(), "Shop!", "chat", true, NOW, "owner")).toHaveProperty("error");
    expect(setGrant(EMPTY_GRANTS, withChat(), "shop", "Chat", true, NOW, "owner")).toHaveProperty("error");
  });

  test("a duplicate or an unknown field refuses the whole file", () => {
    const grant = { slug: "shop", connector: "chat", at: NOW, by: "owner" };
    expect(parseGrants(JSON.stringify({ version: 1, grants: [grant, grant] }))).toHaveProperty("error");
    expect(parseGrants(JSON.stringify({ version: 1, grants: [{ ...grant, extra: true }] }))).toHaveProperty("error");
    expect(parseGrants(JSON.stringify({ version: 1, grants: [{ ...grant, slug: "../x" }] }))).toHaveProperty("error");
    expect(parseGrants("")).toEqual({ file: EMPTY_GRANTS });
  });
});
