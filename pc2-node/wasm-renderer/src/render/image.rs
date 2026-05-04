//! Image renderer — decode, resize, watermark, and re-encode.
//!
//! Supports JPEG, PNG, WebP, GIF input. Output is always lossy
//! (JPEG or WebP) to prevent extraction of the original asset.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};

use crate::watermark::apply_watermark;
use crate::{OutputFormat, RenderCommand, RenderResult};

const DEFAULT_MAX_WIDTH: u32 = 1920;
const DEFAULT_MAX_HEIGHT: u32 = 1080;
const DEFAULT_JPEG_QUALITY: u8 = 85;

/// Render an image, returning (metadata, raw_bytes).
pub fn render_image_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let img = match image::load_from_memory(plaintext) {
        Ok(img) => img,
        Err(e) => return (RenderResult::error(format!("image decode: {e}")), None),
    };

    let max_w = cmd.max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let max_h = cmd.max_height.unwrap_or(DEFAULT_MAX_HEIGHT);
    let img = resize_if_needed(img, max_w, max_h);

    let mut rgba: RgbaImage = img.to_rgba8();

    if let Some(ref wm) = cmd.watermark {
        apply_watermark(&mut rgba, wm);
    }

    let format = cmd.output_format.unwrap_or_default();
    encode_output_raw(&rgba, format)
}

fn resize_if_needed(img: DynamicImage, max_w: u32, max_h: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_w && h <= max_h {
        return img;
    }

    let ratio_w = max_w as f64 / w as f64;
    let ratio_h = max_h as f64 / h as f64;
    let ratio = ratio_w.min(ratio_h);

    let new_w = (w as f64 * ratio) as u32;
    let new_h = (h as f64 * ratio) as u32;

    img.resize_exact(new_w, new_h, FilterType::Lanczos3)
}

fn encode_output_raw(rgba: &RgbaImage, format: OutputFormat) -> (RenderResult, Option<Vec<u8>>) {
    let mut buf = Vec::new();

    let content_type = match format {
        // `Html` is an EPUB-only format; for pixel pipelines we fall
        // back to JPEG so legacy callers never crash.
        OutputFormat::Jpeg | OutputFormat::Html => {
            let rgb = DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
            let mut encoder = JpegEncoder::new_with_quality(&mut buf, DEFAULT_JPEG_QUALITY);
            if let Err(e) = encoder.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            ) {
                return (RenderResult::error(format!("jpeg encode: {e}")), None);
            }
            "image/jpeg"
        }
        OutputFormat::Png => {
            let dyn_img = DynamicImage::ImageRgba8(rgba.clone());
            let mut cursor = std::io::Cursor::new(&mut buf);
            if let Err(e) = dyn_img.write_to(&mut cursor, ImageFormat::Png) {
                return (RenderResult::error(format!("png encode: {e}")), None);
            }
            "image/png"
        }
        OutputFormat::Webp => {
            let dyn_img = DynamicImage::ImageRgba8(rgba.clone());
            let mut cursor = std::io::Cursor::new(&mut buf);
            if let Err(e) = dyn_img.write_to(&mut cursor, ImageFormat::WebP) {
                return (RenderResult::error(format!("webp encode: {e}")), None);
            }
            "image/webp"
        }
    };

    let result = RenderResult {
        success: true,
        content_type: Some(content_type.to_string()),
        total_pages: Some(1),
        output_size: Some(buf.len()),
        ..Default::default()
    };

    (result, Some(buf))
}
