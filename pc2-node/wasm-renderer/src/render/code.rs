//! Code renderer — syntax-highlighted source code to image.
//!
//! Uses `syntect` for syntax highlighting with a dark editor theme,
//! then renders highlighted text to a bitmap image using the bitmap font.

use image::{Rgba, RgbaImage};
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;

use crate::render::text::draw_char;
use crate::watermark::apply_watermark;
use crate::{RenderCommand, RenderResult};

const CANVAS_WIDTH: u32 = 900;
const LINE_HEIGHT: u32 = 18;
const CHAR_WIDTH: u32 = 8;
const PADDING: u32 = 16;
const LINE_NUM_WIDTH: u32 = 48;
const MAX_LINES: usize = 100;

const BG_COLOR: Rgba<u8> = Rgba([43, 48, 59, 255]);
const LINE_NUM_COLOR: Rgba<u8> = Rgba([101, 115, 126, 255]);
const DEFAULT_FG: Rgba<u8> = Rgba([192, 197, 206, 255]);

pub fn render_code_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let text = match std::str::from_utf8(plaintext) {
        Ok(t) => t,
        Err(_) => return (RenderResult::error("code content is not valid UTF-8"), None),
    };

    let ss = SyntaxSet::load_defaults_newlines();
    let ts = ThemeSet::load_defaults();

    let syntax = detect_syntax(&ss, &cmd.mime_type)
        .unwrap_or_else(|| ss.find_syntax_plain_text());

    let theme = ts
        .themes
        .get("base16-ocean.dark")
        .or_else(|| ts.themes.values().next())
        .expect("no themes available");

    let mut highlighter = HighlightLines::new(syntax, theme);

    let raw_lines: Vec<&str> = text.lines().take(MAX_LINES).collect();
    let num_lines = raw_lines.len().max(1) as u32;
    let max_w = cmd.max_width.unwrap_or(CANVAS_WIDTH);
    let canvas_height = (num_lines * LINE_HEIGHT + PADDING * 2).max(100);

    let mut img = RgbaImage::from_pixel(max_w, canvas_height, BG_COLOR);

    let line_num_digits = format!("{}", raw_lines.len()).len() as u32;
    let actual_line_num_w = (line_num_digits + 1) * CHAR_WIDTH + 8;
    let text_start_x = PADDING + actual_line_num_w.max(LINE_NUM_WIDTH);

    for (idx, line) in raw_lines.iter().enumerate() {
        let y = PADDING + idx as u32 * LINE_HEIGHT;

        let num_str = format!("{:>width$}", idx + 1, width = line_num_digits as usize);
        for (ci, ch) in num_str.chars().enumerate() {
            let x = PADDING + ci as u32 * CHAR_WIDTH;
            draw_char(&mut img, x, y, ch, LINE_NUM_COLOR);
        }

        let highlighted = highlighter.highlight_line(line, &ss);
        match highlighted {
            Ok(regions) => {
                let mut x = text_start_x;
                for (style, token) in regions {
                    let fg = Rgba([style.foreground.r, style.foreground.g, style.foreground.b, 255]);
                    for ch in token.chars() {
                        if x + CHAR_WIDTH > max_w - PADDING {
                            break;
                        }
                        draw_char(&mut img, x, y, ch, fg);
                        x += CHAR_WIDTH;
                    }
                }
            }
            Err(_) => {
                let mut x = text_start_x;
                for ch in line.chars() {
                    if x + CHAR_WIDTH > max_w - PADDING {
                        break;
                    }
                    draw_char(&mut img, x, y, ch, DEFAULT_FG);
                    x += CHAR_WIDTH;
                }
            }
        }
    }

    if let Some(ref wm) = cmd.watermark {
        apply_watermark(&mut img, wm);
    }

    let dyn_img = image::DynamicImage::ImageRgba8(img);
    let rgb = dyn_img.to_rgb8();
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92);
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
            total_pages: Some(1),
            output_size: Some(buf.len()),
            ..Default::default()
        },
        Some(buf),
    )
}

fn detect_syntax<'a>(
    ss: &'a SyntaxSet,
    mime: &str,
) -> Option<&'a syntect::parsing::SyntaxReference> {
    let ext = match mime {
        "application/javascript" | "text/javascript" => "js",
        "application/json" => "json",
        "application/xml" | "text/xml" => "xml",
        "application/x-yaml" | "text/yaml" | "text/x-yaml" => "yaml",
        "application/toml" | "text/x-toml" => "toml",
        "application/x-sh" | "text/x-shellscript" => "sh",
        "text/x-python" => "py",
        "text/x-rust" | "text/rust" => "rs",
        "text/x-c" | "text/x-csrc" => "c",
        "text/x-c++" | "text/x-c++src" => "cpp",
        "text/x-java" | "text/x-java-source" => "java",
        "text/x-go" | "text/x-golang" => "go",
        "text/x-typescript" => "ts",
        "text/css" => "css",
        "text/html" => "html",
        "text/x-ruby" => "rb",
        "text/x-php" => "php",
        "text/x-swift" => "swift",
        "text/x-kotlin" => "kt",
        "text/x-sql" => "sql",
        "text/markdown" | "text/x-markdown" => "md",
        _ => return None,
    };
    ss.find_syntax_by_extension(ext)
}
