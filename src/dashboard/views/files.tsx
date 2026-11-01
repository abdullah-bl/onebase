/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { call, on } from "../api";
import { Empty, Icon, ago, bytes, errorText, fullTime, throttle, toast } from "../ui";

type File = { id: string; createdAt: number; size: number; contentType: string | null; sha256: string };

export function FilesView() {
  const [files, setFiles] = useState<File[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);

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
    const refresh = throttle(() => void load(), 2000);
    const off = on("call", (r) => {
      if (r.type === "mutation" || r.type === "action" || r.type === "http") refresh();
    });
    return () => {
      off();
      refresh.cancel();
    };
  }, []);

  const upload = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    setUploading(chosen.length);
    let done = 0;
    for (const file of chosen) {
      try {
        const token = await call<string>("uploadToken");
        const res = await fetch(`/api/storage/upload?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error(`${file.name}: upload failed (${res.status})`);
        done++;
      } catch (e) {
        toast(errorText(e), "error");
      }
      setUploading((n) => n - 1);
    }
    if (done) toast(done === 1 ? "File uploaded" : `${done} files uploaded`);
    if (picker.current) picker.current.value = "";
    void load();
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast("Id copied");
    } catch {
      toast("Couldn't copy: the browser blocked it", "error");
    }
  };

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
          <p class="muted">Uploaded with <code>ctx.storage</code> or from here, newest first.</p>
        </div>
        <div class="toolbar">
          <input ref={picker} class="sr-only" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(e) => void upload((e.target as HTMLInputElement).files)} />
          <button class="btn primary" disabled={uploading > 0} onClick={() => picker.current?.click()}>
            <Icon name="upload" size={14} /> {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
          </button>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}
      {files === null && !error ? (
        <div class="file-grid">{[0, 1, 2, 3].map((i) => <div key={i} class="skeleton" style="height:210px" />)}</div>
      ) : files?.length === 0 ? (
        <Empty title="No files yet">Upload one here, or call ctx.storage.store() from a function.</Empty>
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
                <div class="file-actions">
                  <button class="btn small" onClick={() => void copyId(f.id)}><Icon name="copy" size={12} /> Copy id</button>
                  <button class="btn small danger" onClick={() => remove(f)}>Delete</button>
                </div>
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
