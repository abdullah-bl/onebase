// A stand-in for S3, in memory: enough of the API for backups (put, multipart, get, head, list,
// delete). Signatures aren't checked. `objects` is open to tests, to plant or damage what's stored.

export function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const xml = (body: string, status = 200) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "Content-Type": "application/xml" } });
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const q = url.searchParams;
      if (!key && req.method === "GET") {
        const prefix = q.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const items = keys.map((k) => `<Contents><Key>${escape(k)}</Key><Size>${objects.get(k)!.byteLength}</Size></Contents>`).join("");
        return xml(`<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      if (req.method === "POST" && q.has("uploads")) {
        const id = crypto.randomUUID();
        uploads.set(id, new Map());
        return xml(`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT" && q.has("uploadId")) {
        uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { headers: { ETag: `"part-${q.get("partNumber")}"` } });
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const parts = [...uploads.get(q.get("uploadId")!)!.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
        uploads.delete(q.get("uploadId")!);
        objects.set(key, new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
        return xml(`<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escape(key)}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { headers: { ETag: '"whole"' } });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const found = objects.get(key);
      if (!found) return xml(`<Error><Code>NoSuchKey</Code><Message>No such key</Message></Error>`, 404);
      const headers = { "Content-Length": String(found.byteLength), ETag: '"x"', "Last-Modified": new Date().toUTCString() };
      return new Response(req.method === "HEAD" ? null : (found as BodyInit), { headers });
    },
  });
  return {
    objects,
    /** An s3:// URL for `prefix` in this server's one bucket. */
    url: (prefix: string) => `s3://bucket/${prefix}?endpoint=http://127.0.0.1:${server.port}&accessKeyId=test&secretAccessKey=test&region=us-east-1`,
    stop: () => server.stop(true),
  };
}
