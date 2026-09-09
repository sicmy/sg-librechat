import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ imagePath }: { imagePath: string }) => (
    <span data-testid="image-path">{imagePath}</span>
  ),
}));
jest.mock('../FilePreviewDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: () => null,
}));

describe('message image source', () => {
  it.each([
    ['/api/files/sg-image/file_test', 'blob:temporary', '/api/files/sg-image/file_test'],
    ['/images/original.png', '/images/preview.png', '/images/preview.png'],
    ['/api/share/example/image', undefined, '/api/share/example/image'],
  ])('selects the correct source for %s', (filepath, preview, expected) => {
    const message = {
      messageId: 'message',
      files: [{ file_id: 'file_test', type: 'image/png', filename: 'test.png', filepath, preview }],
    } as TMessage;
    render(<Files message={message} />);
    expect(screen.getByTestId('image-path')).toHaveTextContent(expected);
  });
});
