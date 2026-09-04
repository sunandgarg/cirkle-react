import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { safeHttpUrl } from "@/lib/safeUrl";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

const ImageLightbox = ({ src, alt, onClose }: ImageLightboxProps) => {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setZoom(MIN_ZOOM);
  }, [src]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(value + 1, MAX_ZOOM));
      if (event.key === "-") setZoom((value) => Math.max(value - 1, MIN_ZOOM));
      if (event.key === "0") setZoom(MIN_ZOOM);
    };
    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const zoomIn = () => setZoom((value) => Math.min(value + 1, MAX_ZOOM));
  const zoomOut = () => setZoom((value) => Math.max(value - 1, MIN_ZOOM));
  const safeSrc = safeHttpUrl(src);

  if (!safeSrc) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image preview"}
      className="fixed inset-0 z-[120] overflow-auto overscroll-contain bg-black/95 animate-fade-in"
      onClick={onClose}
      data-testid="image-lightbox"
    >
      <div
        className="fixed right-3 z-[122] flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 p-1.5 shadow-2xl backdrop-blur-md sm:right-5"
        style={{ top: "max(12px, calc(env(safe-area-inset-top) + 8px))" }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom === MIN_ZOOM}
          aria-label="Zoom out"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:opacity-35"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom === MAX_ZOOM}
          aria-label="Zoom in"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:opacity-35"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
        {zoom > MIN_ZOOM && (
          <button
            type="button"
            onClick={() => setZoom(MIN_ZOOM)}
            aria-label="Reset zoom"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
          >
            <RotateCcw className="h-5 w-5" />
          </button>
        )}
        <a
          href={safeSrc}
          download
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download image"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
        >
          <Download className="h-5 w-5" />
        </a>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close image preview"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        className="flex min-h-full min-w-full items-center justify-center p-3 sm:p-8"
      >
        <img
          src={safeSrc}
          alt={alt || ""}
          className="block max-h-[92dvh] max-w-[94vw] select-none object-contain transition-transform duration-150"
          style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
          onClick={(event) => {
            event.stopPropagation();
            setZoom((value) => value === MIN_ZOOM ? 2 : MIN_ZOOM);
          }}
          draggable={false}
        />
      </div>

      <p
        className="pointer-events-none fixed bottom-3 left-1/2 z-[121] -translate-x-1/2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-medium text-white/80 backdrop-blur"
        style={{ bottom: "max(12px, calc(env(safe-area-inset-bottom) + 8px))" }}
      >
        {zoom === MIN_ZOOM ? "Tap image to zoom · tap outside to close" : `${zoom}× · tap image to fit`}
      </p>
    </div>,
    document.body,
  );
};

export default ImageLightbox;
