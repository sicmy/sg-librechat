import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TStartupConfig } from 'librechat-data-provider';
import ModelSelector from '../ModelSelector';

describe('ModelSelector', () => {
  it('stays hidden when model selection is disabled even if an enforced default spec exists', () => {
    const startupConfig = {
      interface: { modelSelect: false },
      modelSpecs: {
        prioritize: true,
        enforce: true,
        list: [{ name: 'sg-default', label: 'SG AI Gateway', default: true }],
      },
    } as unknown as TStartupConfig;

    const { container } = render(<ModelSelector startupConfig={startupConfig} />);

    expect(container).toBeEmptyDOMElement();
  });
});
