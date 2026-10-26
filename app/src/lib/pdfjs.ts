// pdf.js（古い WebView でも動く legacy 版）を、使うときだけ読み込む。サムネイル（pdfThumb）とプレビュー（PdfViewer）で共通
export type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfJs> | null = null;

export function loadPdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
    }
    return pdfjs;
  })().catch((e) => {
    // 読み込めなかったら、次に使うときにもう一度試す
    loading = null;
    throw e;
  });
  return loading;
}
