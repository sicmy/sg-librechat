const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_SEGMENT = /\.[A-Za-z_][A-Za-z0-9_]*|\[(?:"(?:[^"\\]|\\.)*"|(?:0|[1-9][0-9]*))\]/g;

/** Format normalized JSON paths for display; unsupported syntax stays unchanged. */
export function formatJsonPath(path: string): string {
  if (!path.startsWith('$')) return path;
  let cursor = 1;
  let display = '$';
  for (const match of path.matchAll(PATH_SEGMENT)) {
    if (match.index !== cursor) return path;
    const segment = match[0];
    cursor += segment.length;
    if (!segment.startsWith('["')) {
      display += segment;
      continue;
    }
    try {
      const key: string = JSON.parse(segment.slice(1, -1));
      display += SIMPLE_KEY.test(key) ? `.${key}` : segment;
    } catch {
      return path;
    }
  }
  return cursor === path.length ? display : path;
}
