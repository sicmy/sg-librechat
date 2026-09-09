import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { render } from '@testing-library/react';
import { remarkJsonPaths } from '../paths';

describe('answer body JSONPath presentation', () => {
  it.each([
    ['$["warehouse"]: 중앙 창고', '$.warehouse: 중앙 창고'],
    ['경로: $["items"][1]["quantity"] (수량)', '경로: $.items[1].quantity (수량)'],
    ['`$["items"][1]["unit_price"]`', '$.items[1].unit_price'],
    ['**$["warehouse"]**', '$.warehouse'],
    ['$["warehouse"].', '$.warehouse.'],
    ['$["a.b"]["name"]', '$["a.b"].name'],
    ['$["items"][*]["quantity"]', '$["items"][*]["quantity"]'],
    ['$["items"][', '$["items"]['],
    ['`const value = $["warehouse"];`', 'const value = $["warehouse"];'],
    ['"$["warehouse"]"', '"$["warehouse"]"'],
    ['prefix$["warehouse"]', 'prefix$["warehouse"]'],
    ['[$["warehouse"]](https://example.com)', '$["warehouse"]'],
  ])('renders %s safely', (content, expected) => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkJsonPaths]}>{content}</ReactMarkdown>,
    );
    expect(container.textContent).toBe(expected);
  });

  it('formats tables but preserves fenced source code', () => {
    const content = '| 경로 |\n| --- |\n| `$["warehouse"]` |\n\n```js\n$["warehouse"]\n```';
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkJsonPaths]}>{content}</ReactMarkdown>,
    );
    expect(container.querySelector('td')?.textContent).toBe('$.warehouse');
    expect(container.querySelector('pre')?.textContent).toBe('$["warehouse"]\n');
    expect(content).toContain('`$["warehouse"]`');
  });
});
