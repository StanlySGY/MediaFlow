import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const Boom = () => {
  throw new Error('render exploded');
};

describe('<ErrorBoundary />', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a usable page instead of a blank one when a child throws', () => {
    // React logs the caught error itself; keep the test output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('页面出现错误')).toBeInTheDocument();
    // The message is what a user can paste back when reporting the crash.
    expect(screen.getByText('render exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回到文件转写' })).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>正常内容</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    expect(screen.queryByText('页面出现错误')).not.toBeInTheDocument();
  });
});
