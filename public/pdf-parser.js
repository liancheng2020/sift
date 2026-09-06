const MAX_PAGES = 200;
const MAX_TEXT_LENGTH = 150_000;

function pageText(items) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

export async function extractPdfText(file, onProgress = () => {}) {
  let pdf;
  try {
    const pdfjs = await import("/vendor/pdfjs.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs.mjs";
    const bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
    if (pdf.numPages > MAX_PAGES) throw new Error(`PDF 超过 ${MAX_PAGES} 页限制`);

    const pages = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      if (text) {
        pages.push(`[第 ${pageNumber} 页]\n${text}`);
        characterCount += text.length;
      }
      onProgress({ page: pageNumber, total: pdf.numPages });
      if (characterCount > MAX_TEXT_LENGTH) throw new Error("PDF 内容过长，请控制在 15 万字符以内");
      if (pageNumber % 5 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const result = pages.join("\n\n").trim();
    if (result.length < 80) throw new Error("PDF 未提取到足够文字，可能是扫描件或图片型 PDF");
    return result;
  } catch (error) {
    if (error?.name === "PasswordException") throw new Error("PDF 已加密，请先移除密码后重新上传");
    throw new Error(error?.message || "PDF 解析失败，请确认文件可以正常打开");
  } finally {
    if (typeof pdf?.destroy === "function") await pdf.destroy().catch(() => {});
  }
}
