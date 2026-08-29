import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TMessage } from 'librechat-data-provider';
import EffortSelector, { EffortControl } from '../EffortSelector';
import Container from '../Messages/Content/Container';

const mockSetOption = jest.fn();
const QUESTION_TEXT = 'Question';
let mockUserRole = 'USER';
let mockConversation: {
  endpoint: string;
  model: string;
  reasoning_effort?: string;
} | null = null;

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
}));

jest.mock('../Messages/Content/Files', () => () => null);

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { role: mockUserRole } }),
  useSetIndexOptions: () => ({
    setOption: (key: string) => (value: string) => mockSetOption(key, value),
  }),
  useLocalize: () => (key: string) =>
    ({
      com_ui_response_depth: 'Response depth',
      com_ui_response_depth_quick: 'Quick',
      com_ui_response_depth_balanced: 'Balanced',
      com_ui_response_depth_deep: 'Deep',
    })[key] ?? key,
}));

describe('EffortControl', () => {
  test('shows an icon-only response-depth select with Balanced selected', async () => {
    const user = userEvent.setup();
    render(<EffortControl value="high" onChange={jest.fn()} />);

    const select = screen.getByRole('combobox', { name: 'Response depth: Balanced' });
    expect(select).toBeInTheDocument();
    expect(screen.queryByText('Balanced')).not.toBeInTheDocument();

    await user.click(select);

    expect(screen.getByRole('option', { name: 'Quick' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: 'Balanced' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Deep' })).toHaveAttribute('aria-selected', 'false');
  });

  test('reports the selected effort', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<EffortControl value="high" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Response depth: Balanced' }));
    await user.click(screen.getByRole('option', { name: 'Deep' }));

    expect(onChange).toHaveBeenCalledWith('max');
  });
});

describe('EffortSelector', () => {
  beforeEach(() => {
    mockConversation = null;
    mockUserRole = 'USER';
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

    const select = screen.getByRole('combobox', { name: 'Response depth: Balanced' });
    await user.click(select);

    await user.click(screen.getByRole('option', { name: 'Deep' }));

    expect(mockSetOption).toHaveBeenCalledWith('reasoning_effort', 'max');
  });
});

describe('submitted effort badge', () => {
  beforeEach(() => {
    mockUserRole = 'USER';
  });

  test('shows the recorded response depth to administrators', () => {
    mockUserRole = 'ADMIN';
    const message = {
      isCreatedByUser: true,
      metadata: { sgEffort: 'high' },
    } as TMessage;

    render(
      <Container message={message}>
        <span>{QUESTION_TEXT}</span>
      </Container>,
    );

    expect(screen.getByText('Response depth: Balanced')).toBeInTheDocument();
  });

  test('hides the recorded response depth from regular users', () => {
    const message = {
      isCreatedByUser: true,
      metadata: { sgEffort: 'high' },
    } as TMessage;

    render(
      <Container message={message}>
        <span>{QUESTION_TEXT}</span>
      </Container>,
    );

    expect(screen.queryByText('Response depth: Balanced')).not.toBeInTheDocument();
  });
});
