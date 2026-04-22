//! Text renderer — render plaintext as an image.
//!
//! Converts text content to a readable image with line wrapping,
//! configurable font size, and watermark overlay.

use image::{Rgba, RgbaImage};

use crate::watermark::apply_watermark;
use crate::{RenderCommand, RenderResult};

const CANVAS_WIDTH: u32 = 640;
const LINE_HEIGHT: u32 = 20;
const CHAR_WIDTH: u32 = 8;
const PADDING: u32 = 24;
const JPEG_MAX_DIM: u32 = 16384; // Keep well below JPEG's 65535 and browser rendering limits
const MAX_LINES: usize = ((JPEG_MAX_DIM - 48) / 20) as usize; // ~816 lines per page
const BG_COLOR: Rgba<u8> = Rgba([250, 250, 248, 255]);
const TEXT_COLOR: Rgba<u8> = Rgba([30, 30, 30, 255]);

/// Render text, returning (metadata, raw_bytes).
pub fn render_text_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let text = match std::str::from_utf8(plaintext) {
        Ok(t) => t,
        Err(_) => return (RenderResult::error("text content is not valid UTF-8"), None),
    };

    // For text, cap width at CANVAS_WIDTH regardless of requested max_width.
    // Text should read like a page, not stretch edge-to-edge.
    let max_w = CANVAS_WIDTH;
    let chars_per_line = ((max_w - PADDING * 2) / CHAR_WIDTH) as usize;

    let wrapped_lines = wrap_text(text, chars_per_line, MAX_LINES);
    let num_lines = wrapped_lines.len() as u32;
    let canvas_height = (num_lines * LINE_HEIGHT + PADDING * 2).max(100).min(JPEG_MAX_DIM);

    let mut img = RgbaImage::from_pixel(max_w, canvas_height, BG_COLOR);

    for (line_idx, line) in wrapped_lines.iter().enumerate() {
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

    let result = RenderResult {
        success: true,
        content_type: Some("image/jpeg".to_string()),
        total_pages: Some(1),
        output_size: Some(buf.len()),
        ..Default::default()
    };

    (result, Some(buf))
}

pub(crate) fn wrap_text(text: &str, max_chars: usize, max_lines: usize) -> Vec<String> {
    let mut lines = Vec::new();

    for raw_line in text.lines() {
        if lines.len() >= max_lines {
            break;
        }

        if raw_line.is_empty() {
            lines.push(String::new());
            continue;
        }

        let mut current = String::new();
        for word in raw_line.split_whitespace() {
            if lines.len() >= max_lines {
                break;
            }

            if current.len() + word.len() + 1 > max_chars && !current.is_empty() {
                lines.push(std::mem::take(&mut current));
                if lines.len() >= max_lines {
                    break;
                }
            }

            if word.len() > max_chars && current.is_empty() {
                let mut start = 0;
                while start < word.len() && lines.len() < max_lines {
                    let end = (start + max_chars).min(word.len());
                    lines.push(word[start..end].to_string());
                    start = end;
                }
                continue;
            }

            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        if !current.is_empty() && lines.len() < max_lines {
            lines.push(current);
        }
    }

    lines
}

/// Draw a single character using a minimal 8x16 bitmap representation.
pub(crate) fn draw_char(img: &mut RgbaImage, x: u32, y: u32, ch: char, color: Rgba<u8>) {
    let (w, h) = img.dimensions();

    if !ch.is_ascii_graphic() && ch != ' ' {
        for dy in 2..8 {
            for dx in 1..5 {
                let px = x + dx;
                let py = y + dy;
                if px < w && py < h {
                    img.put_pixel(px, py, color);
                }
            }
        }
        return;
    }

    if ch == ' ' {
        return;
    }

    let glyph = crate::watermark::get_bitmap_char_ext(ch);
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..6u32 {
            if bits & (1 << (5 - col)) != 0 {
                let px = x + col;
                let py = y + row as u32;
                if px < w && py < h {
                    img.put_pixel(px, py, color);
                }
            }
        }
    }
}
