/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { call, on } from "../api";
import { Empty, ago, bytes, errorText, fullTime, toast } from "../ui";

type File = { id: string; createdAt: number; size: number; contentType: string | null; sha256: string };

export function FilesView() {
  const [files, setFiles] = useState<File[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (before?: number) => {
    try {
      const page = await call<File[]>("files", { before: before ?? null, limit: 60 });
      setFiles((prev) => (before ? [...(prev ?? []), ...page] : page));
      setMore(page.length === 60);
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    void load();
    return on("call", (r) => {
      if (r.type === "mutation" || r.type === "action" || r.type === "http") void load();
    });
  }, []);

  const remove = async (f: File) => {
    if (!confirm(`Delete file ${f.id}? Documents that reference it will point to a missing file.`)) return;
    try {
      await call("deleteFile", { id: f.id });
      toast("File deleted");
      setFiles((list) => list?.filter((x) => x.id !== f.id) ?? null);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div class="page wide">
      <header class="page-head">
        <div>
          <h1>Files</h1>
          <p class="muted">Uploaded with <code>ctx.storage</code>, newest first.</p>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}
      {files?.length === 0 ? (
        <Empty title="No files yet">Files appear here after an upload or ctx.storage.store().</Empty>
      ) : (
        <div class="file-grid">
          {files?.map((f) => {
            const url = `/api/storage/${f.id}`;
            const image = f.contentType?.startsWith("image/");
            return (
              <div class="file-card">
                <a class="file-preview" href={url} target="_blank" rel="noopener">
                  {image ? <img src={url} alt="" loading="lazy" /> : <span>{(f.contentType ?? "file").split("/")[1]?.slice(0, 8) ?? "file"}</span>}
                </a>
                <div class="file-meta">
                  <code title={f.id}>{f.id}</code>
                  <p class="muted">
                    {bytes(f.size)} · {f.contentType ?? "unknown type"} · <span title={fullTime(f.createdAt)}>{ago(f.createdAt)}</span>
                  </p>
                </div>
                <button class="btn small danger" onClick={() => remove(f)}>Delete</button>
              </div>
            );
          })}
        </div>
      )}
      {more && files && (
        <div class="more">
          <button class="btn" onClick={() => load(files[files.length - 1]!.createdAt)}>Load more</button>
        </div>
      )}
    </div>
  );
}
