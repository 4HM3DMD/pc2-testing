//! PDF renderer — full-fidelity rasterisation via `hayro`.
//!
//! `hayro` is a pure-Rust, `#![forbid(unsafe_code)]` PDF rasteriser that
//! compiles cleanly to `wasm32-wasip1`.  It handles fonts, vector graphics,
//! images and text layout natively — no text-extraction fallback needed.
//!
//! Flow:
//!   PDF bytes ──► hayro-syntax (parse) ──► hayro (rasterise page)
//!     ──► Pixmap (RGBA8) ──► watermark ──► JPEG encode ──► output

use std::sync::Arc;

use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::RenderSettings;
use hayro::hayro_interpret::InterpreterSettings;
use image::{ImageBuffer, Rgba, RgbaImage};

use crate::watermark::apply_watermark;
use crate::{RenderCommand, RenderResult};

pub fn render_pdf_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let data = Arc::new(plaintext.to_vec());
    let pdf = match Pdf::new(data) {
        Ok(p) => p,
        Err(e) => return (RenderResult::error(format!("PDF parse: {e:?}")), None),
    };

    let pages = pdf.pages();
    let total_pages = pages.len() as u32;

    if total_pages == 0 {
        return (RenderResult::error("PDF has no pages"), None);
    }

    let page_idx = cmd.page.unwrap_or(0) as usize;
    if page_idx >= pages.len() {
        return (
            RenderResult::error(format!(
                "page {} out of range (total: {})",
                page_idx + 1,
                total_pages
            )),
            None,
        );
    }

    let page = &pages[page_idx];

    let max_w = cmd.max_width.unwrap_or(800);
    let (native_w, _native_h) = page.render_dimensions();
    let scale = if native_w > 0.0 {
        (max_w as f32 / native_w).min(3.0)
    } else {
        1.0
    };

    let interpreter_settings = InterpreterSettings::default();
    let render_settings = RenderSettings {
        x_scale: scale,
        y_scale: scale,
        width: None,
        height: None,
        bg_color: WHITE,
    };

    let pixmap = hayro::render(page, &interpreter_settings, &render_settings);

    let w = pixmap.width() as u32;
    let h = pixmap.height() as u32;
    let rgba_bytes = pixmap.data_as_u8_slice();

    let mut img: RgbaImage = ImageBuffer::from_raw(w, h, rgba_bytes.to_vec())
        .unwrap_or_else(|| RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255])));

    if let Some(ref wm) = cmd.watermark {
        apply_watermark(&mut img, wm);
    }

    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
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
            content_type: Some("image/jpeg".to_string()),
            total_pages: Some(total_pages),
            output_size: Some(buf.len()),
            ..Default::default()
        },
        Some(buf),
    )
}
