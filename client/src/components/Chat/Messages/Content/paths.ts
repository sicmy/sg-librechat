import type { Root, RootContent } from 'mdast';
import { formatJsonPath } from '~/components/SidePanel/Citations/path';

const PROSE_PATH =
  /(^|[\s(:：])(?<path>\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:"(?:[^"\\]|\\.)*"|(?:0|[1-9][0-9]*))\])+)(?=$|[\s,;:!?):：。]|\.(?:\s|$))/g;

/** Presentation only: never transform executable blocks, links, or embedded code expressions. */
export function remarkJsonPaths() {
  return (tree: Root): void => {
    const transform = (node: Root | RootContent): void => {
      if (node.type === 'inlineCode') {
        node.value = formatJsonPath(node.value);
        return;
      }
      if (node.type === 'text') {
        node.value = node.value.replace(
          PROSE_PATH,
          (_match, prefix: string, path: string) => prefix + formatJsonPath(path),
        );
        return;
      }
      if (node.type === 'link' || node.type === 'linkReference') return;
      if ('children' in node) {
        for (const child of node.children) transform(child);
      }
    };
    transform(tree);
  };
}
