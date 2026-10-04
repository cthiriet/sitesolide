/**
 * An S3 endpoint on the loopback, path-style, holding its objects in memory:
 * just what Bun's S3 client asks of a bucket here, a put, a multipart upload,
 * a listing by prefix and page, a read and a delete. It checks that every
 * request is signed with the expected access key, and nothing more: the
 * signature itself is the client's business, not this test's.
 */
export type FakeS3 = {
  url: string;
  bucket: string;
  objects: Map<string, Uint8Array>;
  requests: string[];
  /** When set, every request answers 503: the bucket is down. */
  down: { value: boolean };
  stop: () => void;
};

const XML = { "Content-Type": "application/xml" };

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function startFakeS3(accessKeyId: string, bucket = "backups"): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const requests: string[] = [];
  const down = { value: false };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (down.value) return new Response("<Error><Code>ServiceUnavailable</Code><Message>down</Message></Error>", { status: 503, headers: XML });
      if (!(req.headers.get("authorization") ?? "").includes(`Credential=${accessKeyId}/`)) {
        return new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", { status: 403, headers: XML });
      }
      const [, name, ...rest] = url.pathname.split("/");
      if (name !== bucket) return new Response("<Error><Code>NoSuchBucket</Code><Message>no</Message></Error>", { status: 404, headers: XML });
      const key = decodeURIComponent(rest.join("/"));
      const body = req.method === "PUT" || req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);

      if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const after = url.searchParams.get("start-after") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? "1000");
        const all = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix) && candidate > after).sort();
        const page = all.slice(0, max);
        const contents = page
          .map((k) => `<Contents><Key>${escape(k)}</Key><LastModified>2026-10-04T12:00:00.000Z</LastModified><ETag>"e"</ETag><Size>${objects.get(k)!.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
          .join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${all.length > page.length}</IsTruncated>${contents}</ListBucketResult>`,
          { headers: XML },
        );
      }
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = crypto.randomUUID();
        uploads.set(id, new Map());
        return new Response(`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { headers: XML });
      }
      if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        const parts = uploads.get(url.searchParams.get("uploadId") ?? "");
        if (parts === undefined) return new Response("<Error><Code>NoSuchUpload</Code><Message>no</Message></Error>", { status: 404, headers: XML });
        parts.set(Number(url.searchParams.get("partNumber")), body);
        return new Response(null, { headers: { ETag: `"part${url.searchParams.get("partNumber")}"` } });
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        const id = url.searchParams.get("uploadId")!;
        const parts = uploads.get(id)!;
        objects.set(key, Bun.concatArrayBuffers([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part), Infinity, true));
        uploads.delete(id);
        return new Response(`<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`, { headers: XML });
      }
      if (req.method === "PUT") {
        objects.set(key, body);
        return new Response(null, { headers: { ETag: '"e"' } });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const object = objects.get(key);
        if (object === undefined) return new Response("<Error><Code>NoSuchKey</Code><Message>no</Message></Error>", { status: 404, headers: XML });
        return new Response(req.method === "HEAD" ? null : (object as Uint8Array<ArrayBuffer>), { headers: { "Content-Length": String(object.byteLength), ETag: '"e"' } });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("<Error><Code>NotImplemented</Code><Message>no</Message></Error>", { status: 501, headers: XML });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bucket, objects, requests, down, stop: () => void server.stop(true) };
}
