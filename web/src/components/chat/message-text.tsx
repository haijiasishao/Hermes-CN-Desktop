import { lazy, Suspense, useState } from "react";
import { FileDown } from "lucide-react";
import {
  hasMediaFileRefs,
  hasSandboxFileRefs,
  downloadMediaFile,
  MEDIA_LINE_RE,
  parseMediaFileRefs,
  parseSandboxFileRefs,
  type MediaFileRef,
} from "@/lib/media-file-link";
import { runtime } from "@/lib/runtime";
import s from "./message-timeline.module.css";

interface MessageTextProps {
  text: string;
  streaming?: boolean;
}

const MarkdownText = lazy(() =>
  import("./markdown-renderer").then((module) => ({
    default: module.MarkdownText,
  })),
);

function InlineText({ text }: Pick<MessageTextProps, "text">) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function PlainMessageText({ text }: Pick<MessageTextProps, "text">) {
  const blocks = text.split(/```/g);

  return (
    <>
      {blocks.map((block, index) => {
        const isCode = index % 2 === 1;
        if (isCode) {
          const lines = block.replace(/^\w+\n/, "").trimEnd();
          return (
            <pre key={index} className={s.codeBlock}>
              <code>{lines}</code>
            </pre>
          );
        }

        return block
          .split(/\n{2,}/)
          .filter((paragraph) => paragraph.length > 0)
          .map((paragraph, paragraphIndex) => (
            <p key={`${index}-${paragraphIndex}`}>
              <InlineText text={paragraph} />
            </p>
          ));
      })}
    </>
  );
}

function isShareAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Save the bytes returned by the native authenticated download command.
 * Android Remote-only first uses the Tauri system save dialog and writes to
 * its selected content URI. Web Share and a Blob anchor remain fallbacks for
 * older/unsupported runtimes.
 */
async function saveDownloadedFile(
  dataBase64: string,
  filename: string,
  mimeType: string | undefined,
): Promise<"saved" | "shared" | "downloaded"> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const effectiveMimeType = mimeType || "application/octet-stream";
  const blob = new Blob([bytes], { type: effectiveMimeType });
  let nativeSaveError: unknown;

  if (runtime.androidRemoteOnly) {
    try {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const extension = filename.includes(".") ? filename.split(".").pop() : undefined;
      const savePath = await save({
        defaultPath: filename,
        filters: extension ? [{ name: "文件", extensions: [extension] }] : undefined,
      });
      if (!savePath) throw new Error("已取消保存");
      await writeFile(savePath, bytes);
      return "saved";
    } catch (error) {
      if (isShareAbort(error) || (error instanceof Error && error.message === "已取消保存")) {
        throw error;
      }
      nativeSaveError = error;
    }
  }

  const navigatorLike = typeof navigator !== "undefined" ? navigator : undefined;

  if (
    runtime.androidRemoteOnly &&
    typeof File !== "undefined" &&
    navigatorLike &&
    typeof navigatorLike.share === "function" &&
    typeof navigatorLike.canShare === "function"
  ) {
    const file = new File([blob], filename, { type: effectiveMimeType });
    try {
      if (navigatorLike.canShare({ files: [file] })) {
        await navigatorLike.share({ files: [file], title: filename });
        return "shared";
      }
    } catch (error) {
      if (isShareAbort(error)) throw new Error("已取消保存");
      // A WebView can expose canShare but reject the later share call. Fall
      // through to the ordinary anchor path before surfacing an error.
    }
  }

  // If the Android system save plugin was present but failed, do not report a
  // misleading successful blob download: Android WebView may silently ignore
  // that fallback. Surface the native error to the visible card instead.
  if (runtime.androidRemoteOnly && nativeSaveError) {
    throw new Error(
      `系统保存失败：${nativeSaveError instanceof Error ? nativeSaveError.message : "未知错误"}`,
    );
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}

/**
 * A card that renders a MEDIA: file reference as a downloadable link.
 * On Tauri/Android the native bridge carries cookies; on plain web it
 * falls back to a token-in-query download.
 */
function MediaFileCard({ ref: mediaRef }: { ref: MediaFileRef }) {
  const { filename, path } = mediaRef;
  const label = mediaRef.displayName || filename || path;
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await downloadMediaFile(path);
      if (result.ok && result.dataBase64) {
        const outcome = await saveDownloadedFile(
          result.dataBase64,
          result.filename ?? filename,
          result.mimeType,
        );
        setFeedback(
          outcome === "saved"
            ? "已保存到所选位置"
            : outcome === "shared"
              ? "已打开系统保存面板"
              : "已发起下载",
        );
      } else if (result.ok && result.fallbackUrl) {
        // Browser fallback: use a temporary anchor to trigger download.
        const a = document.createElement("a");
        a.href = result.fallbackUrl;
        a.download = filename;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setFeedback("已发起下载");
      } else {
        setError("下载通道未就绪，请重新连接后重试");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={s.mediaFileCard}>
      <FileDown size={16} aria-hidden="true" />
      <button
        type="button"
        className={s.mediaFileLink}
        title={`下载文件：${path}`}
        onClick={handleDownload}
        disabled={downloading}
      >
        {downloading ? "下载中…" : label}
      </button>
      {feedback && <span className={s.mediaFileSuccess} role="status">{feedback}</span>}
      {error && (
        <span className={s.mediaFileError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
/**
 * Split text into segments: non-MEDIA parts (rendered as markdown/plain text)
 * and MEDIA: lines (rendered as file download cards).
 */
function MessageTextWithMedia({ text, streaming }: MessageTextProps) {
  const lines = text.split("\n");
  const segments: Array<{ type: "text"; content: string } | { type: "media"; ref: MediaFileRef }> = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      segments.push({ type: "text", content: textBuf.join("\n") });
      textBuf = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // Match MEDIA: lines with absolute paths (Unix or Windows).
    const mediaMatch = MEDIA_LINE_RE.exec(trimmed);
    if (mediaMatch) {
      flushText();
      const filePath = mediaMatch[1];
      const refs = parseMediaFileRefs(`MEDIA:${filePath}`);
      if (refs.length > 0) {
        segments.push({ type: "media", ref: refs[0] });
      } else {
        textBuf.push(line);
      }
      continue;
    }

    const sandboxRefs = parseSandboxFileRefs(trimmed);
    if (sandboxRefs.length > 0) {
      flushText();
      segments.push({ type: "media", ref: sandboxRefs[0] });
    } else {
      textBuf.push(line);
    }
  }
  flushText();

  return (
    <div className={s.messageText}>
      {segments.map((segment, index) => {
        if (segment.type === "media") {
          return <MediaFileCard key={`media-${index}`} ref={segment.ref} />;
        }
        if (!segment.content.trim()) return null;
        return (
          <Suspense key={`text-${index}`} fallback={<PlainMessageText text={segment.content} />}>
            <MarkdownText text={segment.content} streaming={streaming} />
          </Suspense>
        );
      })}
    </div>
  );
}

export function MessageText({ text, streaming = false }: MessageTextProps) {
  if (hasMediaFileRefs(text) || hasSandboxFileRefs(text)) {
    return <MessageTextWithMedia text={text} streaming={streaming} />;
  }

  return (
    <div className={s.messageText}>
      <Suspense fallback={<PlainMessageText text={text} />}>
        <MarkdownText text={text} streaming={streaming} />
      </Suspense>
    </div>
  );
}
