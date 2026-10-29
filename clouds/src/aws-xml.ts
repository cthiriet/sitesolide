/**
 * Just enough XML to read what the EC2 Query API answers: elements, their
 * text, the five predefined entities and character references, CDATA,
 * comments and the declaration. Attributes are skipped, namespaces dropped
 * from names: EC2 puts nothing in either that aws.ts reads.
 *
 * A document type declaration is refused rather than read, so that no
 * entity of its own is ever expanded, and the depth is bounded. Anything
 * malformed throws an XmlError, which aws.ts turns into `provider-unreadable`.
 *
 * Lists come as a container of `<item>` elements (`<keySet><item>...`), and
 * the order of elements may vary between answers
 * (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Query-Requests.html):
 * the helpers below find children by name, never by position.
 */

export type XmlElement = { name: string; children: XmlElement[]; text: string };

export class XmlError extends Error {}

const MAX_DEPTH = 64;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&([^;&\s]{1,10});/g, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new XmlError(`unreadable character reference ${whole}`);
      return String.fromCodePoint(code);
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new XmlError(`unreadable character reference ${whole}`);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name];
    if (value === undefined) throw new XmlError(`unknown entity ${whole}`);
    return value;
  });
}

/** `ec2:item` -> `item`. */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** The document's root element. */
export function parseXml(source: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;
  const length = source.length;

  const appendText = (text: string): void => {
    const current = stack.at(-1);
    if (current !== undefined) current.text += text;
    else if (text.trim() !== "") throw new XmlError("text outside the root element");
  };

  while (index < length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      appendText(decode(source.slice(index)));
      break;
    }
    if (open > index) appendText(decode(source.slice(index, open)));

    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end === -1) throw new XmlError("unterminated declaration");
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) throw new XmlError("unterminated comment");
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end === -1) throw new XmlError("unterminated CDATA section");
      appendText(source.slice(open + 9, end));
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", open)) throw new XmlError("a document type declaration is not read");

    // A tag: find its end outside of quoted attribute values.
    let end = open + 1;
    let quote: string | null = null;
    for (; end < length; end++) {
      const character = source[end]!;
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= length) throw new XmlError("unterminated tag");
    const inside = source.slice(open + 1, end);
    index = end + 1;

    if (inside.startsWith("/")) {
      const name = localName(inside.slice(1).trim());
      const closed = stack.pop();
      if (closed === undefined || closed.name !== name) throw new XmlError(`unexpected closing tag ${name}`);
      if (stack.length === 0) root = closed;
      continue;
    }
    const selfClosing = inside.endsWith("/");
    const name = localName((/^[^\s/]+/.exec(inside)?.[0] ?? "").trim());
    if (name === "") throw new XmlError("a tag without a name");
    if (root !== null) throw new XmlError("more than one root element");
    const element: XmlElement = { name, children: [], text: "" };
    stack.at(-1)?.children.push(element);
    if (selfClosing) {
      if (stack.length === 0) root = element;
      continue;
    }
    stack.push(element);
    if (stack.length > MAX_DEPTH) throw new XmlError("nested too deep");
  }
  if (stack.length > 0) throw new XmlError(`unclosed element ${stack.at(-1)!.name}`);
  if (root === null) throw new XmlError("no root element");
  return root;
}

/** The first child of that name. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((candidate) => candidate.name === name);
}

/** Down a path of names: `at(instance, "instanceState", "name")`. */
export function at(element: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let current = element;
  for (const name of names) current = child(current, name);
  return current;
}

/** The trimmed text at a path, or null when an element of it is absent or empty. */
export function textAt(element: XmlElement | undefined, ...names: string[]): string | null {
  const found = at(element, ...names);
  const text = found?.text.trim() ?? "";
  return found === undefined || text === "" ? null : text;
}

/** The `<item>` elements of a list: `items(response, "keySet")`. */
export function items(element: XmlElement | undefined, ...names: string[]): XmlElement[] {
  return (at(element, ...names)?.children ?? []).filter((candidate) => candidate.name === "item");
}

/** A `tagSet` as a record: `{Name: "web", "managed-by": "sitesolide"}`. */
export function tagsOf(element: XmlElement | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const item of items(element, "tagSet")) {
    const key = textAt(item, "key");
    if (key !== null) tags[key] = at(item, "value")?.text.trim() ?? "";
  }
  return tags;
}

/** `<` `>` `&` `"` `'` escaped: what the fake writes its answers with. */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[character]};`);
}
