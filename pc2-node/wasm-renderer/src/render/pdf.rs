//! PDF renderer — extract page content and rasterize.
//!
//! Uses `lopdf` for PDF parsing. Currently extracts text content
//! and renders it as an image. Full page rasterization is a future
//! enhancement (requires a PDF rendering engine in WASM).

use crate::{RenderCommand, RenderResult};

pub fn render_pdf_raw(_plaintext: &[u8], _cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    // TODO: Implement PDF page extraction with lopdf
    (RenderResult::error("PDF rendering not yet implemented in WASM — use server-side fallback"), None)
}
