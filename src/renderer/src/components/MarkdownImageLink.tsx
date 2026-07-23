import { t } from "@renderer/i18n";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { ArchicodeProjectPathLink } from "./ResearchMarkdown";

type LocalPreviewResult = {
  error?: boolean;
  href: string;
  src?: string;
};

export function MarkdownImageLink({ href, label, projectTarget, loadProjectImage, onProjectPathLink, onOpenExternal }: {
  href: string;
  label: ReactNode;
  projectTarget: ArchicodeProjectPathLink | null;
  loadProjectImage?: (target: ArchicodeProjectPathLink) => Promise<string>;
  onProjectPathLink?: (target: ArchicodeProjectPathLink) => void;
  onOpenExternal: (href: string) => void;
}) {
  const [localPreview, setLocalPreview] = useState<LocalPreviewResult>({ href });
  const [failedPreviewHref, setFailedPreviewHref] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectTarget || !loadProjectImage) {
      setLocalPreview({ href, error: Boolean(projectTarget) });
      return;
    }
    setLocalPreview({ href });
    void loadProjectImage(projectTarget)
      .then((src) => {
        if (!cancelled) setLocalPreview({ href, src });
      })
      .catch(() => {
        if (!cancelled) setLocalPreview({ href, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [href, loadProjectImage, projectTarget?.relativePath]);

  const previewSrc = projectTarget
    ? (localPreview.href === href ? localPreview.src : undefined)
    : (/^https:\/\//i.test(href) ? href : undefined);
  const previewFailed = (localPreview.href === href && localPreview.error) || failedPreviewHref === previewSrc;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (projectTarget) {
      onProjectPathLink?.(projectTarget);
      return;
    }
    onOpenExternal(href);
  };

  return (
    <span className="research-image-link-preview">
      <a
        className="research-image-thumbnail-link"
        href={href}
        target={projectTarget ? undefined : "_blank"}
        rel={projectTarget ? undefined : "noreferrer"}
        onClick={handleClick}
        aria-label={t("Open image")}
      >
        {previewSrc && !previewFailed ? (
          <img
            src={previewSrc}
            alt={typeof label === "string" ? label : t("Image preview")}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedPreviewHref(previewSrc)}
          />
        ) : (
          <span className="research-image-thumbnail-placeholder">
            {previewFailed ? t("Preview unavailable") : t("Loading image preview…")}
          </span>
        )}
      </a>
      <a
        className="research-image-source-link"
        href={href}
        target={projectTarget ? undefined : "_blank"}
        rel={projectTarget ? undefined : "noreferrer"}
        onClick={handleClick}
        title={projectTarget?.relativePath ?? href}
      >
        {label || projectTarget?.relativePath || href}
      </a>
    </span>
  );
}
