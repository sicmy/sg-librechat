import React from 'react';
import { render, screen } from '@testing-library/react';
import CitationLocation from '../Location';
import { formatJsonPath } from '../path';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

test.each([
  ['$["warehouse"]', '$.warehouse'],
  ['$["items"][1]["quantity"]', '$.items[1].quantity'],
  ['$["_id"][0]["value2"]', '$._id[0].value2'],
  ['$.items[1]["quantity"]', '$.items[1].quantity'],
  ['$["unit.price"]["value"]', '$["unit.price"].value'],
  ['$["창고 이름"]', '$["창고 이름"]'],
  ['$["창고"]', '$["창고"]'],
  ['$["0"]', '$["0"]'],
  ['$[""]', '$[""]'],
  ['$["a-b"]', '$["a-b"]'],
  ['$["$"]', '$["$"]'],
  [String.raw`$["ware\u0068ouse"]`, '$.warehouse'],
  [String.raw`$["key[\"nested\"]"]["name"]`, String.raw`$["key[\"nested\"]"].name`],
  [String.raw`$["a\\b"]["name"]`, String.raw`$["a\\b"].name`],
  ['$', '$'],
  ['$..warehouse', '$..warehouse'],
  ['$["items"][*]["quantity"]', '$["items"][*]["quantity"]'],
  ['$["items"][01]', '$["items"][01]'],
  ['$["items"]["unfinished', '$["items"]["unfinished'],
  [String.raw`$["a\q"]`, String.raw`$["a\q"]`],
  ["$['warehouse']", "$['warehouse']"],
])('formats %s as %s without changing path semantics', (path, expected) => {
  expect(formatJsonPath(path)).toBe(expected);
  expect(formatJsonPath(path)).toBe(expected);
});

test('JSON citation display changes without mutating its stored locator', () => {
  const locator = Object.freeze({
    kind: 'structural_path' as const,
    path_type: 'json' as const,
    path: '$["items"][1]["quantity"]',
  });
  render(<CitationLocation locator={locator} />);
  expect(screen.getByText('$.items[1].quantity')).toBeInTheDocument();
  expect(locator.path).toBe('$["items"][1]["quantity"]');
});

test.each(['xml', 'section'] as const)('leaves %s source paths unchanged', (pathType) => {
  const path = '$["warehouse"]';
  render(<CitationLocation locator={{ kind: 'structural_path', path_type: pathType, path }} />);
  expect(screen.getByText(path)).toBeInTheDocument();
});
