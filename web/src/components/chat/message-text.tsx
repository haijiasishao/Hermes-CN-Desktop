import { lazy, Suspense, useState } from "react";
import { FileDown } from "lucide-react";
import {
  hasMediaFileRefs,
  downloadMediaFile,
  MEDIA_LINE_RE,
  parseMediaFileRefs,
  type MediaFileRef,
} from "@/lib/media-file-link";
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

/**
 * A card that renders a MEDIA: file reference as a downloadable link.
 * On Tauri/Android the native bridge carries cookies; on plain web it
 * falls back to a token-in-query download.
 */
function MediaFileCard({ ref: mediaRef }: { ref: MediaFileRef }) {
  const { filename, downloadUrl, path } = mediaRef;
  const label = filename || path;
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const result = await downloadMediaFile(path);
      if (result.ok && result.dataBase64) {
        // Native bridge: convert base64 → Blob → trigger save.
        const binary = atob(result.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename ?? filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      } else {
        setError("下载失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  if (downloadUrl || (typeof window !== "undefined" && window.hermesDesktop?.downloadFile)) {
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
        {error && (
          <span className={s.mediaFileError} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  // Safe fallback when runtime API info is unavailable.
  return (
    <div className={s.mediaFileCard}>
      <FileDown size={16} aria-hidden="true" />
      <span className={s.mediaFilePlaceholder} title={path}>
        {label}
      </span>
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
  if (hasMediaFileRefs(text)) {
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
