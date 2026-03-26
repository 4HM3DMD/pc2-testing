/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Handles flat key-value pairs and simple arrays (- item format).
 */
export function parseSkillFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: raw };

  const meta: Record<string, any> = {};
  const lines = fmMatch[1].split('\n');
  let currentKey = '';

  for (const line of lines) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '' || val === '[]') {
        meta[currentKey] = [];
      } else {
        meta[currentKey] = val;
      }
    } else if (line.match(/^\s+-\s+/) && currentKey) {
      const item = line.replace(/^\s+-\s+/, '').trim();
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(item);
    }
  }

  return { meta, body: fmMatch[2].trim() };
}
