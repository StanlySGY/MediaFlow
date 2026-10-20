import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

const config = { provider: 'openai_compat', model: 'qwen' } as never;

const renderSidebar = (open: boolean, onRequestClose = vi.fn()) =>
  render(
    <Sidebar
      currentView="tasks"
      onViewChange={vi.fn()}
      config={config}
      footStatus={{ text: '在线', status: 'ok' }}
      open={open}
      onRequestClose={onRequestClose}
    />,
  );

/** jsdom has no matchMedia; a query result of `matches` is the whole contract
 *  the sidebar needs from it. */
const stubViewport = (matches: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
};

describe('<Sidebar /> drawer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves the tab order while the mobile drawer is closed', () => {
    stubViewport(false);
    renderSidebar(false);

    // The rail is only translated off-canvas. Without `inert` the first Tab
    // press on a phone lands inside a menu that is not on screen.
    const rail = screen.getByRole('complementary', { hidden: true });
    expect(rail).toHaveAttribute('inert');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button', { name: /文件转写/ })).not.toBeInTheDocument();
  });

  it('is reachable once the drawer is open', () => {
    stubViewport(false);
    renderSidebar(true);

    const rail = screen.getByRole('complementary');
    expect(rail).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: /文件转写/ })).toBeInTheDocument();
  });

  it('stays in the layout at desktop width, where it is not a drawer', () => {
    stubViewport(true);
    renderSidebar(false);

    const rail = screen.getByRole('complementary');
    expect(rail).not.toHaveAttribute('inert');
    expect(rail).not.toHaveAttribute('aria-hidden');
  });

  it('closes on a leftward swipe, but not on a tap or a short drag', () => {
    stubViewport(false);
    const onRequestClose = vi.fn();
    renderSidebar(true, onRequestClose);

    const rail = screen.getByRole('complementary');
    const swipe = (from: number, to: number) => {
      rail.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), {
        touches: [{ clientX: from }],
      }));
      rail.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true }), {
        changedTouches: [{ clientX: to }],
      }));
    };

    swipe(300, 295); // a tap with a little drift
    swipe(300, 280); // 20px: inside the accidental-movement range
    expect(onRequestClose).not.toHaveBeenCalled();

    swipe(300, 200);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
