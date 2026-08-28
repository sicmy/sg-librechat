import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import EffortSelector, { EffortControl } from '../EffortSelector';

const mockSetOption = jest.fn();
let mockConversation: {
  endpoint: string;
  model: string;
  reasoning_effort?: string;
} | null = null;

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
}));

jest.mock('~/hooks', () => ({
  useSetIndexOptions: () => ({
    setOption: (key: string) => (value: string) => mockSetOption(key, value),
  }),
  useLocalize: () => (key: string) =>
    ({
      com_endpoint_reasoning_effort: 'Reasoning Effort',
      com_ui_low: 'Low',
      com_ui_high: 'High',
      com_ui_max: 'Max',
    })[key] ?? key,
}));

describe('EffortControl', () => {
  test('shows low, high, and max with high selected by default', () => {
    render(<EffortControl value="high" onChange={jest.fn()} />);

    expect(screen.getByRole('radiogroup', { name: 'Reasoning Effort' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Low' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Max' })).toHaveAttribute('aria-checked', 'false');
  });

  test('reports the selected effort', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<EffortControl value="high" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Low' }));

    expect(onChange).toHaveBeenCalledWith('low');
  });
});

describe('EffortSelector', () => {
  beforeEach(() => {
    mockConversation = null;
    mockSetOption.mockClear();
  });

  test('is hidden outside the SG AI Gateway default model', () => {
    mockConversation = { endpoint: 'Other', model: 'default' };

    const { container } = render(<EffortSelector />);

    expect(container).toBeEmptyDOMElement();
  });

  test('defaults to high and stores the selected conversation effort', async () => {
    const user = userEvent.setup();
    mockConversation = { endpoint: 'SG AI Gateway', model: 'default' };
    render(<EffortSelector />);

    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: 'Max' }));

    expect(mockSetOption).toHaveBeenCalledWith('reasoning_effort', 'max');
  });
});
