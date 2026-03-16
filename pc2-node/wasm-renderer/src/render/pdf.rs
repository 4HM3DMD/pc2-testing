//! PDF renderer — parse PDF, extract text per page, and rasterize to image.
//!
//! Uses `lopdf` for PDF parsing + text extraction, then renders the extracted
//! text using the same bitmap font system as the text renderer. This keeps
//! all plaintext content inside WASM linear memory.
//!
//! Limitation: renders extracted text only — images, vector graphics, and
//! complex layout within the PDF are not reproduced. Suitable for text-heavy
//! documents (the majority of dDRM-protected PDFs).

use image::{Rgba, RgbaImage};
use lopdf::Document;

use crate::render::text::{draw_char, wrap_text};
use crate::watermark::apply_watermark;
use crate::{RenderCommand, RenderResult};

const CANVAS_WIDTH: u32 = 800;
const LINE_HEIGHT: u32 = 20;
const CHAR_WIDTH: u32 = 8;
const PADDING: u32 = 24;
const MAX_LINES: usize = 80;
const BG_COLOR: Rgba<u8> = Rgba([255, 255, 255, 255]);
const TEXT_COLOR: Rgba<u8> = Rgba([30, 30, 30, 255]);

pub fn render_pdf_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let doc = match Document::load_mem(plaintext) {
        Ok(d) => d,
        Err(e) => return (RenderResult::error(format!("PDF parse: {e}")), None),
    };

    let pages = doc.get_pages();
    let total_pages = pages.len() as u32;

    if total_pages == 0 {
        return (RenderResult::error("PDF has no pages"), None);
    }

    // cmd.page is 0-indexed; lopdf uses 1-indexed page numbers
    let page_idx = cmd.page.unwrap_or(0);
    let page_num = page_idx + 1;
    if page_num > total_pages {
        return (
            RenderResult::error(format!(
                "page {} out of range (total: {})",
                page_num, total_pages
            )),
            None,
        );
    }

    let text = match doc.extract_text(&[page_num]) {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) => format!("[Page {} — no extractable text content]", page_num),
        Err(e) => format!("[Page {}: text extraction failed — {}]", page_num, e),
    };

    let max_w = cmd.max_width.unwrap_or(CANVAS_WIDTH);
    let chars_per_line = ((max_w.saturating_sub(PADDING * 2)) / CHAR_WIDTH).max(20) as usize;
    let wrapped = wrap_text(&text, chars_per_line, MAX_LINES);
    let num_lines = wrapped.len().max(1) as u32;
    let canvas_height = (num_lines * LINE_HEIGHT + PADDING * 2).max(200);

    let mut img = RgbaImage::from_pixel(max_w, canvas_height, BG_COLOR);

    for (line_idx, line) in wrapped.iter().enumerate() {
        let y_base = PADDING + line_idx as u32 * LINE_HEIGHT;
        for (char_idx, ch) in line.chars().enumerate() {
            let x_base = PADDING + char_idx as u32 * CHAR_WIDTH;
            draw_char(&mut img, x_base, y_base, ch, TEXT_COLOR);
        }
    }

    if let Some(ref wm) = cmd.watermark {
        apply_watermark(&mut img, wm);
    }

    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let rgb = dyn_img.to_rgb8();
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90);
    if let Err(e) = encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    ) {
        return (RenderResult::error(format!("jpeg encode: {e}")), None);
    }

    (
        RenderResult {
            success: true,
            error: None,
            content_type: Some("image/jpeg".to_string()),
            total_pages: Some(total_pages),
            output_size: Some(buf.len()),
        },
        Some(buf),
    )
}
