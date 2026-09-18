"use client";

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { ProgressBar } from "@/components/ui";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * First-party copies of what PDF.js loads on demand: image decoders for
 * JBIG2/JPEG 2000 scans, character maps, and the 14 standard fonts. Served from
 * /public so nothing is ever fetched from a CDN (§24). If the folder is
 * missing, PDFs that need them still open, with those parts left blank.
 */
const ASSETS = "/pdfjs/";

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // Ours, not a CDN's: the stock worker file, copied from the same package at
  // install time (scripts/copy-pdfjs.mjs) and served first-party.
  pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
  return pdfjs;
}

/**
 * Fetches the PDF engine and its worker while there's a network, so the service
 * worker has them when there isn't. A scan that won't open at a counter because
 * the *viewer* was never downloaded is the failure this app exists to prevent.
 */
export function warmPdfViewer(): void {
  void loadPdfjs().catch(() => {});
  void fetch(`${ASSETS}pdf.worker.min.mjs`).catch(() => {});
}

interface PageBox { number: number; width: number; height: number }

const MAX_CANVAS_PIXELS = 12_000_000; // phones refuse canvases much past this

function Page({ pdf, box, width }: { pdf: PDFDocumentProxy; box: PageBox; width: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  // render a page when it's about to be seen, not all fifty up front
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!near || !el || width <= 0) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const page = await pdf.getPage(box.number);
      if (cancelled) return;
      const cssScale = width / box.width;
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixels = box.width * box.height * cssScale * cssScale * ratio * ratio;
      if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale: cssScale * ratio });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      task = page.render({ canvas: el, viewport });
      await task.promise.catch(() => {});
      page.cleanup();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, box, width]);

  // give the pixels back when the page is far away again
  useEffect(() => {
    const el = canvas.current;
    if (near || !el) return;
    el.width = 0;
    el.height = 0;
  }, [near]);

  return (
    <div ref={holder} className="mx-auto shrink-0 overflow-hidden rounded-sm bg-white" style={{ width, aspectRatio: `${box.width} / ${box.height}` }}>
      <canvas ref={canvas} className="block size-full" role="img" aria-label={`Page ${box.number}`} />
    </div>
  );
}

export function PdfPages({ content, zoomed, onPageCount, onFailed }: {
  content: Bytes;
  zoomed: boolean;
  onPageCount?: (pages: number) => void;
  onFailed: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [boxes, setBoxes] = useState<PageBox[]>([]);
  const [fit, setFit] = useState(0);
  const callbacks = useRef({ onPageCount, onFailed });
  useEffect(() => { callbacks.current = { onPageCount, onFailed }; });

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const loading = pdfjs.getDocument({
          // a copy: PDF.js moves the buffer into its worker, and the original is still wanted for Share and Download
          data: content.slice(),
          // (PDF.js 6 has no eval path left to switch off; nothing here needs 'unsafe-eval')
          enableXfa: false,
          wasmUrl: `${ASSETS}wasm/`, cMapUrl: `${ASSETS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${ASSETS}standard_fonts/`,
        });
        task = loading;
        const doc = await loading.promise;
        if (cancelled) return void loading.destroy();
        const sizes: PageBox[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const v = page.getViewport({ scale: 1 });
          sizes.push({ number: n, width: v.width, height: v.height });
        }
        if (cancelled) return;
        setPdf(doc);
        setBoxes(sizes);
        callbacks.current.onPageCount?.(doc.numPages);
      } catch (e) {
        console.warn("[viewer] pdf failed:", (e as Error)?.name); // the name only: a message could quote the document
        if (!cancelled) callbacks.current.onFailed();
      }
    })();
    return () => {
      cancelled = true;
      setPdf(null);
      setBoxes([]);
      void task?.destroy(); // frees the document and everything the worker holds for it
    };
  }, [content]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setFit(Math.max(0, Math.min(el.clientWidth - 16, 1100)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    // touch-action left alone: the browser's own pinch-zoom works on the pages, on top of the Zoom button
    <div ref={scroller} className="size-full overflow-auto overscroll-contain px-2 py-3" tabIndex={0} aria-label="Document pages">
      {!pdf ? (
        <div className="mx-auto mt-[30dvh] w-64 max-w-full text-ink"><ProgressBar label="Opening…" /></div>
      ) : (
        <div className="flex w-max min-w-full flex-col gap-3">
          {boxes.map((box) => <Page key={box.number} pdf={pdf} box={box} width={fit * (zoomed ? 2 : 1)} />)}
        </div>
      )}
    </div>
  );
}
